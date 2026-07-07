"""Business analytics derived from indexed conversation data."""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.kb.database import get_db
from app.kb.models import Chat, Contact, Message, Thread, User

router = APIRouter()


def get_overview(workspace_id: int, db: Session) -> dict:
    total_messages = (
        db.query(func.count(Message.id)).join(Chat)
        .filter(Chat.workspace_id == workspace_id).scalar() or 0
    )
    total_chats = (
        db.query(func.count(Chat.id))
        .filter(Chat.workspace_id == workspace_id, Chat.status == "done").scalar() or 0
    )
    total_contacts = (
        db.query(func.count(Contact.id))
        .filter(Contact.workspace_id == workspace_id).scalar() or 0
    )
    date_range = (
        db.query(func.min(Chat.date_from), func.max(Chat.date_to))
        .filter(Chat.workspace_id == workspace_id).first()
    )
    categories = (
        db.query(Chat.category, func.count(Chat.id).label("chats"), func.sum(Chat.message_count).label("messages"))
        .filter(Chat.workspace_id == workspace_id, Chat.status == "done")
        .group_by(Chat.category).all()
    )
    return {
        "total_messages": total_messages,
        "total_chats": total_chats,
        "total_contacts": total_contacts,
        "date_from": date_range[0].isoformat() if date_range and date_range[0] else None,
        "date_to":   date_range[1].isoformat() if date_range and date_range[1] else None,
        "categories": [
            {"category": c.category, "chats": c.chats, "messages": int(c.messages or 0)}
            for c in categories
        ],
    }


def get_activity(workspace_id: int, days: int, db: Session) -> dict:
    since = datetime.utcnow() - timedelta(days=days)
    rows = (
        db.query(func.date_trunc("day", Message.timestamp).label("day"), func.count(Message.id).label("count"))
        .join(Chat)
        .filter(Chat.workspace_id == workspace_id, Message.timestamp >= since)
        .group_by("day").order_by("day").all()
    )
    return {
        "days": days,
        "data": [{"date": r.day.strftime("%Y-%m-%d"), "messages": r.count} for r in rows if r.day],
    }


def get_top_contacts(workspace_id: int, limit: int, db: Session) -> dict:
    contacts = (
        db.query(Contact)
        .filter(Contact.workspace_id == workspace_id)
        .order_by(Contact.message_count.desc())
        .limit(limit).all()
    )
    return {
        "contacts": [
            {
                "id": c.id,
                "name": c.display_name,
                "messages": c.message_count,
                "chats": c.chat_count,
                "last_seen": c.last_seen.isoformat() if c.last_seen else None,
            }
            for c in contacts
        ]
    }


def get_intents(workspace_id: int, db: Session) -> dict:
    threads = (
        db.query(Thread).join(Chat)
        .filter(Chat.workspace_id == workspace_id, Thread.intent_tags.isnot(None)).all()
    )
    counts: dict[str, int] = {}
    for t in threads:
        for tag in (t.intent_tags or []):
            counts[tag] = counts.get(tag, 0) + 1
    sorted_tags = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:15]
    return {"intents": [{"tag": t, "count": c} for t, c in sorted_tags]}


# ── REST endpoints ──────────────────────────────────────────────────────────────

@router.get("/analytics/overview")
def analytics_overview(workspace_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return get_overview(workspace_id, db)


@router.get("/analytics/activity")
def analytics_activity(workspace_id: int, days: int = 30, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return get_activity(workspace_id, days, db)


@router.get("/analytics/top-contacts")
def analytics_top_contacts(workspace_id: int, limit: int = 10, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return get_top_contacts(workspace_id, limit, db)


@router.get("/analytics/intents")
def analytics_intents(workspace_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return get_intents(workspace_id, db)
