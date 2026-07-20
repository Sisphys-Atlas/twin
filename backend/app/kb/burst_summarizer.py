"""Tier 2 long-term memory — turns quiet live-message bursts into Threads.

Live messages (Tier 1) land in the KB raw, with per-message embeddings but no
thread membership. This job runs periodically: any chat whose unthreaded
messages have gone quiet (no new message for QUIET_MINUTES) gets those
messages segmented into bursts, each burst summarized with Gemini and embedded
— the same shape the import pipeline produces, so hybrid search treats live
history and imported history identically.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import func

from app.kb.database import SessionLocal
from app.kb.models import Chat, Message, Thread

QUIET_MINUTES = 30


def run_burst_summarizer() -> int:
    """One pass. Returns the number of threads created."""
    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=QUIET_MINUTES)

        # Chats with unthreaded real messages whose newest one is quiet.
        # status == "done" keeps us out of chats mid-import (their messages
        # get threaded by the import pipeline itself).
        rows = (
            db.query(Message.chat_id)
            .join(Chat, Chat.id == Message.chat_id)
            .filter(
                Message.thread_id.is_(None),
                Message.sender.isnot(None),
                Message.body.isnot(None),
                Chat.status == "done",
            )
            .group_by(Message.chat_id)
            .having(func.max(Message.timestamp) < cutoff)
            .all()
        )

        created = 0
        for (chat_id,) in rows:
            try:
                created += _summarize_chat_bursts(db, chat_id)
            except Exception as e:
                db.rollback()
                print(f"[memory] burst summarization failed for chat {chat_id}: {e}")
        return created
    finally:
        db.close()


def _summarize_chat_bursts(db, chat_id: int) -> int:
    # segment_threads/summarize_thread only touch .sender/.body/.timestamp,
    # so ORM Message rows work directly in place of ParsedMessage.
    from app.structuring.thread_analyzer import segment_threads, summarize_thread
    from app.kb.embeddings import embed_texts

    msgs = (
        db.query(Message)
        .filter(
            Message.chat_id == chat_id,
            Message.thread_id.is_(None),
            Message.sender.isnot(None),
            Message.body.isnot(None),
        )
        .order_by(Message.timestamp)
        .all()
    )
    if not msgs:
        return 0

    next_index = (
        db.query(func.max(Thread.thread_index)).filter(Thread.chat_id == chat_id).scalar() or 0
    ) + 1

    created = 0
    for burst in segment_threads(msgs):
        data = summarize_thread(burst)
        thread = Thread(
            chat_id=chat_id,
            thread_index=next_index,
            start_time=burst[0].timestamp,
            end_time=burst[-1].timestamp,
            message_count=len(burst),
            summary=data.get("summary", ""),
            intent_tags=data.get("intent_tags", []),
            key_entities=data.get("key_entities", {}),
        )
        db.add(thread)
        db.flush()

        if thread.summary:
            try:
                thread.embedding = embed_texts([thread.summary])[0]
            except Exception:
                pass  # summary is still keyword-searchable without an embedding

        for m in burst:
            m.thread_id = thread.id

        next_index += 1
        created += 1

    db.commit()
    return created
