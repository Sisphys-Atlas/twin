"""
Hybrid search: vector cosine similarity + Postgres full-text.

Flow:
  1. Embed the query (Gemini RETRIEVAL_QUERY)
  2. Score every message that has an embedding via cosine similarity
  3. Run Postgres full-text search (tsvector) over message bodies
  4. Merge + deduplicate, boost messages that match both
  5. Return top_k results with metadata (including chat name)
"""

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.kb.embeddings import cosine_similarity, embed_query
from app.kb.models import Chat, Message


def hybrid_search(
    query: str,
    db: Session,
    chat_ids: list[int] | None = None,
    top_k: int = 15,
) -> list[dict]:
    # None = caller wants no chat filter; an EMPTY list means "this workspace
    # has no chats" and must return nothing — falling through unfiltered would
    # search every tenant's messages (cross-tenant leak).
    if chat_ids is not None and len(chat_ids) == 0:
        return []

    base_q = (
        db.query(Message)
        .options(joinedload(Message.chat))
        .filter(Message.sender.isnot(None))
    )
    if chat_ids:
        base_q = base_q.filter(Message.chat_id.in_(chat_ids))

    # ── Vector search ──────────────────────────────────────────────────────
    query_vec = embed_query(query)

    msgs_with_emb = base_q.filter(Message.embedding.isnot(None)).all()
    scored: list[tuple[float, Message]] = [
        (cosine_similarity(query_vec, m.embedding), m)
        for m in msgs_with_emb
    ]
    scored.sort(key=lambda x: x[0], reverse=True)

    # ── Full-text search ───────────────────────────────────────────────────
    fts_msgs = (
        base_q.filter(
            func.to_tsvector("simple", func.coalesce(Message.body, ""))
            .op("@@")(func.plainto_tsquery("simple", query))
        )
        .limit(top_k)
        .all()
    )
    fts_ids = {m.id for m in fts_msgs}

    # ── Merge ──────────────────────────────────────────────────────────────
    seen: dict[int, dict] = {}

    for score, msg in scored[: top_k * 2]:
        seen[msg.id] = {
            "message": msg,
            "score": score,
            "match_type": "hybrid" if msg.id in fts_ids else "vector",
        }

    for msg in fts_msgs:
        if msg.id not in seen:
            seen[msg.id] = {"message": msg, "score": 0.50, "match_type": "keyword"}
        else:
            seen[msg.id]["score"] = min(1.0, seen[msg.id]["score"] + 0.05)
            seen[msg.id]["match_type"] = "hybrid"

    results = sorted(seen.values(), key=lambda x: x["score"], reverse=True)[:top_k]
    return [_fmt(r) for r in results]


def resolve_workspace_chat_ids(workspace_id: int, category: str | None, db: Session) -> list[int]:
    """Return all done chat IDs in a workspace, optionally filtered by category."""
    q = db.query(Chat.id).filter(
        Chat.workspace_id == workspace_id,
        Chat.status == "done",
    )
    if category:
        q = q.filter(Chat.category == category)
    return [row[0] for row in q.all()]


def _fmt(r: dict) -> dict:
    m: Message = r["message"]
    chat_name = m.chat.original_filename if m.chat else None
    category = m.chat.category if m.chat else None
    return {
        "message_id": m.id,
        "chat_id": m.chat_id,
        "chat_name": chat_name,
        "category": category,
        "thread_id": m.thread_id,
        "timestamp": m.timestamp.isoformat() if m.timestamp else None,
        "sender": m.sender,
        "body": m.body,
        "message_type": m.message_type,
        "language": m.language,
        "score": round(r["score"], 4),
        "match_type": r["match_type"],
    }
