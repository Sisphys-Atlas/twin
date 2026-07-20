"""Agent endpoint — customer-service AI + owner co-pilot with streaming SSE."""

import json
from typing import Generator

import google.generativeai as genai
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import get_current_user
from app.kb.database import get_db
from app.kb.models import User
from app.kb.search import hybrid_search, resolve_workspace_chat_ids

router = APIRouter()

_SYSTEM_FALLBACK = """\
You are replying to WhatsApp messages on behalf of the account owner.
Reply in the SAME LANGUAGE as the customer (Arabic, French, or English).
Be concise — this is WhatsApp, not email. 2-3 sentences max. Plain text, no markdown.
Use the customer's name naturally once if you know it.

Customer name: {customer_name}
Recent conversation:
{history}
"""


def _fmt_history(history: list[dict]) -> str:
    if not history:
        return "(new conversation)"
    lines = []
    for m in history[-12:]:
        role = "Customer" if m.get("role") == "customer" else "Agent"
        lines.append(f"{role}: {m.get('content', '')}")
    return "\n".join(lines)


def _fmt_context(messages: list[dict]) -> str:
    lines = []
    for m in messages[:8]:
        ts = (m.get("timestamp") or "")[:16].replace("T", " ")
        body = (m.get("body") or "")[:200]
        chat = m.get("chat_name") or f"Chat {m.get('chat_id', '?')}"
        lines.append(f"[{ts} | {m.get('sender')} | {chat}]: {body}")
    return "\n".join(lines) if lines else "(no past context found)"


def _load_contact_style_examples(customer_name: str, phone: str | None, workspace_id: int | None, db: Session) -> str | None:
    """
    Return up to 25 of the owner's past messages TO this specific contact as style examples.
    Returns None if fewer than 5 examples exist (not enough signal).
    """
    import re as _re
    from app.kb.models import Chat, Message as MsgModel

    ws = workspace_id or 1
    safe_name = _re.sub(r'[<>:"/\\|?*]', '_', customer_name)

    # Find this contact's chat by name (synced) or by live phone record
    chat = db.query(Chat).filter(
        Chat.workspace_id == ws,
        Chat.original_filename.ilike(f"{safe_name}.txt"),
    ).first()

    if chat is None and phone:
        chat = db.query(Chat).filter(
            Chat.workspace_id == ws,
            Chat.filename == f"live_{phone}.txt",
        ).first()

    if chat is None:
        return None

    msgs = (
        db.query(MsgModel)
        .filter(
            MsgModel.chat_id == chat.id,
            MsgModel.sender == "Me",
            MsgModel.body.isnot(None),
            MsgModel.message_type == "text",
        )
        .order_by(MsgModel.timestamp.desc())
        .limit(30)
        .all()
    )

    samples = [m.body.strip() for m in msgs if m.body and m.body.strip() and len(m.body.strip()) > 1]
    if len(samples) < 5:
        return None

    return "\n".join(f"• {s}" for s in samples[:25])


def _stream(
    customer_message: str,
    customer_name: str,
    history: list[dict],
    workspace_id: int | None,
    db: Session,
    phone: str | None = None,
) -> Generator[dict, None, None]:
    genai.configure(api_key=settings.gemini_api_key)

    chat_ids = resolve_workspace_chat_ids(workspace_id, None, db) if workspace_id else None
    context_msgs = hybrid_search(customer_message, db, chat_ids, top_k=8)

    yield {"type": "search_done", "count": len(context_msgs)}

    # Layer 1: global style profile (general writing patterns)
    from app.api.style import load_style
    global_style = load_style()

    # Layer 2: contact-specific examples (how the owner writes to THIS person)
    contact_examples = _load_contact_style_examples(customer_name, phone, workspace_id, db)

    if global_style:
        system = global_style["system_prompt"]
    else:
        system = _SYSTEM_FALLBACK.format(
            customer_name=customer_name or "the customer",
            history=_fmt_history(history),
        )

    # Inject contact-specific tone on top of the global style
    if contact_examples:
        system += (
            f"\n\n--- How you (the owner) specifically write to {customer_name} ---\n"
            f"{contact_examples}\n"
            f"--- Your tone and vocabulary with {customer_name} is DIFFERENT from how you write to others. "
            f"Match the style above exactly when replying to them. ---"
        )

    system += f"\n\nCustomer name: {customer_name or 'the customer'}\nRecent conversation:\n{_fmt_history(history)}"

    prompt = (
        system
        + f"\n\n--- Past conversation context ---\n{_fmt_context(context_msgs)}\n--- End ---\n\n"
        + f"Customer: {customer_message}\n\nReply:"
    )

    model = genai.GenerativeModel(settings.gemini_model)
    response = model.generate_content(
        prompt,
        stream=True,
        generation_config=genai.types.GenerationConfig(temperature=0.4),
    )

    for chunk in response:
        if chunk.text:
            yield {"type": "chunk", "text": chunk.text}

    yield {"type": "done"}


class AgentRequest(BaseModel):
    customer_message: str
    workspace_id: int | None = None
    customer_name: str | None = None
    conversation_history: list[dict] | None = None


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/agent/chat")
def agent_chat(req: AgentRequest, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Stream a customer-service agent response as SSE."""

    def generate():
        try:
            for event in _stream(
                customer_message=req.customer_message,
                customer_name=req.customer_name or "Customer",
                history=req.conversation_history or [],
                workspace_id=req.workspace_id,
                db=db,
            ):
                yield _sse(event)
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc)})
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ── Owner co-pilot ─────────────────────────────────────────────────────────────

_CLASSIFY_PROMPT = """\
Classify this business owner query into one intent. Reply with ONLY valid JSON, nothing else.

Query: "{query}"

Possible intents:
- kb_query     → searching past conversations (questions about what customers said, complaints, requests)
- analytics    → business metrics (counts, volumes, trends, top customers, intent patterns)
- send_message → wants to send a WhatsApp message to someone

JSON format:
{{"intent": "kb_query",     "params": {{"query": "refined search query"}}}}
{{"intent": "analytics",    "params": {{"metric": "overview" | "activity" | "top_contacts" | "intents"}}}}
{{"intent": "send_message", "params": {{"to": "name or number", "message": "the message text"}}}}

Examples:
"What did Ahmed say about the price?"     → kb_query
"How many messages did we get this week?" → analytics, metric=activity
"Who are our most active customers?"      → analytics, metric=top_contacts
"What kinds of requests do we receive?"   → analytics, metric=intents
"Total chats and contacts overview"       → analytics, metric=overview
"Send Khalid that his order ships Friday" → send_message
"""

_KB_SYSTEM = """\
You are a business intelligence assistant answering questions about a company's WhatsApp conversations.
Answer concisely using the provided conversation excerpts as evidence.
Always cite who said what and when. Respond in the same language as the question.
"""

_RECENCY_KEYWORDS = {
    "last", "latest", "recent", "recently", "yesterday", "today", "this week",
    "just", "now", "new", "newest", "currently", "update",
    # Arabic
    "آخر", "أخير", "أحدث", "مؤخراً", "الآن", "اليوم", "الأسبوع",
    # French
    "dernier", "récent", "récemment", "aujourd", "cette semaine",
}

def _is_recency_query(query: str) -> bool:
    q = query.lower()
    return any(kw in q for kw in _RECENCY_KEYWORDS)

_ANALYTICS_SYSTEM = """\
You are a business analyst. Interpret the following data from a WhatsApp business account
and give a clear, actionable insight in 2-4 sentences. Be direct about what the numbers mean.
Respond in the same language as the question.
"""


def _detect_contact_chats(query: str, all_chat_ids: list[int], db: Session) -> list[int] | None:
    """Return ALL chat IDs whose name appears in the query (covers duplicate sync records)."""
    from app.kb.models import Chat
    chats = (
        db.query(Chat.id, Chat.original_filename)
        .filter(Chat.id.in_(all_chat_ids))
        .order_by(Chat.id.desc())   # newest sync records first
        .all()
    )
    q_lower = query.lower()
    print(f"[agent] contact detection — query: '{q_lower}'")
    matches: list[int] = []
    matched_name: str | None = None
    for chat_id, fname in chats:
        if not fname:
            continue
        name = fname.rsplit(".", 1)[0].lower().replace("_", " ").strip()
        if not name:
            continue
        words = [w for w in name.split() if len(w) > 2]
        if name in q_lower or (words and all(w in q_lower for w in words)):
            matches.append(chat_id)
            matched_name = fname
    if matches:
        print(f"[agent] matched contact: '{matched_name}' — {len(matches)} chat record(s): {matches}")
        return matches
    print(f"[agent] no contact match found")
    return None


def _msg_to_result(m) -> dict:
    """Convert a Message ORM row to the same dict shape hybrid_search returns."""
    chat_name = m.chat.original_filename if m.chat else None
    return {
        "message_id": m.id,
        "chat_id": m.chat_id,
        "chat_name": chat_name,
        "category": m.chat.category if m.chat else None,
        "timestamp": m.timestamp.isoformat() if m.timestamp else None,
        "sender": m.sender,
        "body": m.body,
        "message_type": m.message_type,
        "language": m.language,
        "score": 1.0,
        "match_type": "recency",
    }


def _fetch_last_conversation(contact_chat_ids: list[int], db) -> list[dict]:
    """
    Return all messages from the most recent substantive conversation session.
    Session boundary = gap > SESSION_GAP_HOURS between consecutive messages.
    If the most recent session is trivially small (≤ MIN_MSGS), merge it with
    the one before it so we never return a single isolated reply.
    Messages are returned in chronological order (oldest first).
    """
    from sqlalchemy.orm import joinedload
    from app.kb.models import Message as MsgModel

    SESSION_GAP_HOURS = 12  # overnight gaps don't split a conversation
    MIN_MSGS = 2             # a session with ≤ this many messages isn't standalone

    rows = (
        db.query(MsgModel)
        .options(joinedload(MsgModel.chat))
        .filter(
            MsgModel.chat_id.in_(contact_chat_ids),
            MsgModel.body.isnot(None),
            MsgModel.sender.isnot(None),
        )
        .order_by(MsgModel.timestamp.desc())
        .limit(300)
        .all()
    )

    if not rows:
        return []

    # Split into sessions (rows are newest-first)
    sessions: list[list] = []
    current: list = [rows[0]]
    for i in range(1, len(rows)):
        newer = rows[i - 1].timestamp
        older = rows[i].timestamp
        if newer and older and (newer - older).total_seconds() / 3600 > SESSION_GAP_HOURS:
            sessions.append(current)
            current = []
        current.append(rows[i])
    sessions.append(current)

    # Take the most recent session; if it's tiny, merge with the next one
    result = sessions[0]
    if len(result) <= MIN_MSGS and len(sessions) > 1:
        result = result + sessions[1]

    result.reverse()  # chronological order
    return [_msg_to_result(m) for m in result]


def _fetch_recent_window(contact_chat_ids: list[int], db, limit: int = 20) -> list[dict]:
    """Tier 2 short-term memory: the contact's last N raw messages straight
    from the live store, chronological. Always current — no embedding lag."""
    from sqlalchemy.orm import joinedload
    from app.kb.models import Message as MsgModel

    rows = (
        db.query(MsgModel)
        .options(joinedload(MsgModel.chat))
        .filter(
            MsgModel.chat_id.in_(contact_chat_ids),
            MsgModel.body.isnot(None),
            MsgModel.sender.isnot(None),
        )
        .order_by(MsgModel.timestamp.desc())
        .limit(limit)
        .all()
    )
    return [_msg_to_result(m) for m in reversed(rows)]


def _fmt_conversation(messages: list[dict]) -> str:
    """Format a full conversation thread for the Gemini prompt."""
    if not messages:
        return "(no messages found)"
    chat_name = (messages[0].get("chat_name") or "Unknown").rsplit(".", 1)[0].replace("_", " ")
    lines = [f"Conversation with: {chat_name}", ""]
    for m in messages:
        ts = (m.get("timestamp") or "")[:16].replace("T", " ")
        sender = m.get("sender") or "?"
        body = (m.get("body") or "")[:500]
        lines.append(f"[{ts}] {sender}: {body}")
    return "\n".join(lines)


def _owner_stream(query: str, workspace_id: int | None, db: Session) -> Generator[dict, None, None]:
    genai.configure(api_key=settings.gemini_api_key)
    model = genai.GenerativeModel(settings.gemini_model)

    # Step 1: classify intent
    classify_resp = model.generate_content(
        _CLASSIFY_PROMPT.format(query=query),
        generation_config=genai.types.GenerationConfig(temperature=0.0),
    )
    try:
        raw = classify_resp.text.strip().strip("```json").strip("```").strip()
        intent_data = json.loads(raw)
    except Exception:
        intent_data = {"intent": "kb_query", "params": {"query": query}}

    intent = intent_data.get("intent", "kb_query")
    params = intent_data.get("params", {})

    yield {"type": "intent", "intent": intent, "params": params}

    # Step 2: execute
    if intent == "send_message":
        recipient = params.get("to", "")
        raw_instruction = params.get("message", query)

        # Compose the actual message in the owner's style instead of sending the raw instruction
        from app.api.style import load_style
        style = load_style()
        style_hint = (
            f"Write in the owner's style:\n{style['system_prompt']}\n\n"
            if style else
            "Write naturally and conversationally for WhatsApp.\n\n"
        )
        compose_prompt = (
            f"{style_hint}"
            f"The owner wants to send a WhatsApp message to {recipient or 'someone'}.\n\n"
            f"Owner's instruction: {raw_instruction}\n\n"
            f"Write the actual WhatsApp message the owner would send. "
            f"Be natural — this is WhatsApp, not email. Plain text only, no markdown. "
            f"Output ONLY the message text, nothing else."
        )
        composed = model.generate_content(
            compose_prompt,
            generation_config=genai.types.GenerationConfig(temperature=0.5),
        )
        message_text = composed.text.strip()
        signature = (style or {}).get("signature", "")
        if signature:
            message_text = f"{message_text}\n\n{signature}"
        yield {
            "type": "send_preview",
            "to": recipient,
            "message": message_text,
        }
        yield {"type": "done"}
        return

    if intent == "analytics":
        from app.api.analytics import get_overview, get_activity, get_top_contacts, get_intents
        metric = params.get("metric", "overview")
        ws = workspace_id or 1
        if metric == "activity":
            data = get_activity(ws, 30, db)
        elif metric == "top_contacts":
            data = get_top_contacts(ws, 10, db)
        elif metric == "intents":
            data = get_intents(ws, db)
        else:
            data = get_overview(ws, db)

        yield {"type": "analytics", "metric": metric, "data": data}

        # Ask Gemini to interpret the data as a human-readable insight
        insight_prompt = (
            f"{_ANALYTICS_SYSTEM}\n\n"
            f"Owner question: {query}\n\n"
            f"Data: {json.dumps(data, default=str)}\n\n"
            f"Insight:"
        )
        for chunk in model.generate_content(
            insight_prompt,
            stream=True,
            generation_config=genai.types.GenerationConfig(temperature=0.3),
        ):
            if chunk.text:
                yield {"type": "chunk", "text": chunk.text}

        yield {"type": "done"}
        return

    # Default: kb_query
    search_query = params.get("query", query)
    ws = workspace_id or 1
    chat_ids = resolve_workspace_chat_ids(ws, None, db)

    # Brand-new workspace with nothing imported — answer helpfully instead of
    # searching an empty (or worse, unscoped) knowledge base
    if not chat_ids:
        yield {"type": "search_done", "count": 0}
        yield {"type": "chunk", "text": (
            "Your knowledge base is empty for now. Connect your WhatsApp "
            "(top bar) and run “Import history” to bring in your conversations — "
            "then I can answer questions about your customers, search past chats, "
            "and draft replies in your style."
        )}
        yield {"type": "done"}
        return

    recency = _is_recency_query(query)

    # Detect a contact name in the query and restrict to that contact's chats
    contact_chat_ids = _detect_contact_chats(query, chat_ids, db)
    effective_chat_ids = contact_chat_ids if contact_chat_ids else chat_ids

    # Recency + known contact → fetch the full last conversation session
    if recency and contact_chat_ids:
        results = _fetch_last_conversation(contact_chat_ids, db)
        print(f"[agent] last conversation fetch returned {len(results)} messages")
        if results:
            print(f"[agent] date range: {results[0].get('timestamp','?')[:16]} → {results[-1].get('timestamp','?')[:16]}")
        yield {"type": "search_done", "count": len(results)}

        context = _fmt_conversation(results)
        prompt = (
            f"{_KB_SYSTEM}\n\n"
            f"--- Full conversation (most recent session) ---\n{context}\n--- End ---\n\n"
            f"Question: {query}\n\nAnswer:"
        )
    else:
        results = hybrid_search(search_query, db, effective_chat_ids, top_k=20 if recency else 10)
        if recency:
            results = sorted(
                [r for r in results if r.get("timestamp")],
                key=lambda x: x["timestamp"],
                reverse=True,
            )[:10]
        yield {"type": "search_done", "count": len(results)}

        context = _fmt_context(results)
        recency_instruction = "\nIMPORTANT: The user is asking about RECENT or LAST interactions. Focus on the most recent messages — pay attention to the timestamps and highlight the latest exchange.\n" if recency else ""

        # Known contact → always include their live recent window alongside the
        # search hits, so answers reflect the conversation as of right now.
        recent_block = ""
        if contact_chat_ids:
            recent = _fetch_recent_window(contact_chat_ids, db)
            if recent:
                recent_block = (
                    f"--- Most recent messages with this contact (live, chronological) ---\n"
                    f"{_fmt_conversation(recent)}\n--- End recent messages ---\n\n"
                )

        prompt = (
            f"{_KB_SYSTEM}{recency_instruction}\n\n"
            f"{recent_block}"
            f"--- Conversation excerpts ---\n{context}\n--- End ---\n\n"
            f"Question: {query}\n\nAnswer:"
        )

    for chunk in model.generate_content(
        prompt,
        stream=True,
        generation_config=genai.types.GenerationConfig(temperature=0.3),
    ):
        if chunk.text:
            yield {"type": "chunk", "text": chunk.text}

    if results:
        yield {"type": "citations", "data": results[:6]}

    yield {"type": "done"}


class OwnerRequest(BaseModel):
    query: str
    workspace_id: int | None = None


@router.post("/agent/owner")
def agent_owner(req: OwnerRequest, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Stream an owner co-pilot response — routes KB / analytics / send intents."""

    def generate():
        try:
            for event in _owner_stream(req.query, req.workspace_id, db):
                yield _sse(event)
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc)})
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
