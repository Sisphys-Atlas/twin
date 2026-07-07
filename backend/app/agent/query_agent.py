"""
Gemini-based query agent with streaming.

Retrieves relevant messages via hybrid search, then streams a
grounded answer with inline citations (including source chat name).
"""

from typing import Generator

import google.generativeai as genai
from sqlalchemy.orm import Session

from app.config import settings
from app.kb.search import hybrid_search

_SYSTEM = """\
You are an AI assistant that answers questions about WhatsApp business conversations.

Rules:
1. Answer in the SAME LANGUAGE as the user's question (Arabic, French, or English — match exactly).
2. For every fact you state, include a source citation in this format: [Date | Sender | Chat | "brief quote"]
3. If the answer is not found in the provided messages, say so clearly — do not invent information.
4. Be concise and direct.
5. For Arabic, use the same dialect/register as the source messages."""


def _build_context(messages: list[dict]) -> str:
    lines = []
    for m in messages:
        ts = (m["timestamp"] or "")[:16].replace("T", " ")
        body = (m["body"] or "")[:300]
        chat = m.get("chat_name") or f"Chat {m['chat_id']}"
        lines.append(f"[{ts} | {m['sender']} | {chat}]: {body}")
    return "\n\n".join(lines)


def stream_answer(
    query: str,
    db: Session,
    chat_ids: list[int] | None = None,
) -> Generator[dict, None, None]:
    """
    Yields dicts:
      {"type": "chunk",     "text": "..."}   — one per streamed token group
      {"type": "citations", "data": [...]}   — once, after streaming ends
    """
    genai.configure(api_key=settings.gemini_api_key)

    context_messages = hybrid_search(query, db, chat_ids, top_k=15)
    context = _build_context(context_messages)

    prompt = (
        f"{_SYSTEM}\n\n"
        f"--- Relevant conversation excerpts ---\n{context}\n"
        f"--- End of excerpts ---\n\n"
        f"User question: {query}"
    )

    model = genai.GenerativeModel(settings.gemini_model)
    response = model.generate_content(
        prompt,
        stream=True,
        generation_config=genai.types.GenerationConfig(temperature=0.3),
    )

    for chunk in response:
        if chunk.text:
            yield {"type": "chunk", "text": chunk.text}

    citations = [
        {
            "message_id": m["message_id"],
            "chat_id": m["chat_id"],
            "chat_name": m.get("chat_name"),
            "category": m.get("category"),
            "timestamp": m["timestamp"],
            "sender": m["sender"],
            "body": (m["body"] or "")[:150],
            "score": m["score"],
        }
        for m in context_messages[:6]
    ]
    yield {"type": "citations", "data": citations}
