"""Contact list and profile endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_assistant
from app.kb.database import get_db
from app.kb.models import Chat, Contact, ContactAppearance, Message, User

router = APIRouter()


class ContactPatch(BaseModel):
    notes: str | None = None
    tags:  list[str] | None = None


@router.post("/contacts/backfill")
def backfill_contacts(
    workspace_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_assistant),
):
    """Re-run contact extraction over every chat in a workspace. Useful after
    upgrading to a version that indexes contacts from live messages — chats
    that already had messages before that point never got contact rows
    created, since extraction previously only ran during a full sync."""
    from app.kb.contacts import extract_contacts

    chats = db.query(Chat).filter(Chat.workspace_id == workspace_id).all()
    for chat in chats:
        try:
            extract_contacts(chat.id, workspace_id, db)
        except Exception as e:
            print(f"[contacts] backfill failed for chat {chat.id}: {e}")

    count = db.query(Contact).filter(Contact.workspace_id == workspace_id).count()
    return {"chats_processed": len(chats), "contact_count": count}


@router.get("/contacts")
def list_contacts(workspace_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Return all contacts in a workspace ordered by message count."""
    contacts = (
        db.query(Contact)
        .filter(Contact.workspace_id == workspace_id)
        .options(joinedload(Contact.appearances).joinedload(ContactAppearance.chat))
        .order_by(Contact.message_count.desc())
        .all()
    )
    return {
        "workspace_id": workspace_id,
        "total": len(contacts),
        "contacts": [_fmt_contact(c) for c in contacts],
    }


@router.get("/contacts/{contact_id}")
def get_contact(contact_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Return a contact's full profile: appearances across chats + recent messages."""
    contact = (
        db.query(Contact)
        .options(joinedload(Contact.appearances).joinedload(ContactAppearance.chat))
        .filter(Contact.id == contact_id)
        .first()
    )
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found")

    chat_ids = [a.chat_id for a in contact.appearances]
    recent_messages = (
        db.query(Message)
        .options(joinedload(Message.chat))
        .filter(
            Message.chat_id.in_(chat_ids),
            Message.sender == contact.display_name,
            Message.body.isnot(None),
        )
        .order_by(Message.timestamp.desc())
        .limit(20)
        .all()
    )

    return {
        **_fmt_contact(contact),
        "appearances": [
            {
                "chat_id": a.chat_id,
                "chat_name": a.chat.original_filename if a.chat else None,
                "category": a.chat.category if a.chat else None,
                "sender_name": a.sender_name,
                "message_count": a.message_count,
            }
            for a in contact.appearances
        ],
        "recent_messages": [
            {
                "message_id": m.id,
                "chat_id": m.chat_id,
                "chat_name": m.chat.original_filename if m.chat else None,
                "category": m.chat.category if m.chat else None,
                "timestamp": m.timestamp.isoformat() if m.timestamp else None,
                "body": m.body,
                "language": m.language,
            }
            for m in recent_messages
        ],
    }


@router.patch("/contacts/{contact_id}")
def patch_contact(
    contact_id: int,
    body: ContactPatch,
    db: Session = Depends(get_db),
    _: User = Depends(require_assistant),
):
    contact = db.query(Contact).filter(Contact.id == contact_id).first()
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found")
    if body.notes is not None:
        contact.notes = body.notes.strip() or None
    if body.tags is not None:
        contact.tags = [t.strip() for t in body.tags if t.strip()] or None
    db.commit()
    return _fmt_contact(contact)


def _fmt_contact(c: Contact) -> dict:
    return {
        "id": c.id,
        "display_name": c.display_name,
        "message_count": c.message_count,
        "chat_count": c.chat_count,
        "last_seen": c.last_seen.isoformat() if c.last_seen else None,
        "notes": c.notes,
        "tags": c.tags or [],
    }