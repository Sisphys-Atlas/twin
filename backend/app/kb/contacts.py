"""Extract and upsert contact profiles from a processed chat."""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.kb.models import Contact, ContactAppearance, Message


def extract_contacts(chat_id: int, workspace_id: int, db: Session) -> None:
    """
    Called after a chat finishes processing.
    Reads unique senders, upserts them into contacts + contact_appearances.
    """
    rows = (
        db.query(
            Message.sender,
            func.count(Message.id).label("cnt"),
            func.max(Message.timestamp).label("last_seen"),
        )
        .filter(Message.chat_id == chat_id, Message.sender.isnot(None))
        .group_by(Message.sender)
        .all()
    )

    for sender, count, last_seen in rows:
        contact = (
            db.query(Contact)
            .filter(Contact.workspace_id == workspace_id, Contact.display_name == sender)
            .first()
        )
        if not contact:
            contact = Contact(
                workspace_id=workspace_id,
                display_name=sender,
                message_count=0,
                chat_count=0,
            )
            db.add(contact)
            db.flush()

        contact.message_count += count
        contact.chat_count += 1
        if last_seen and (not contact.last_seen or last_seen > contact.last_seen):
            contact.last_seen = last_seen

        appearance = (
            db.query(ContactAppearance)
            .filter(
                ContactAppearance.contact_id == contact.id,
                ContactAppearance.chat_id == chat_id,
            )
            .first()
        )
        if not appearance:
            db.add(ContactAppearance(
                contact_id=contact.id,
                chat_id=chat_id,
                sender_name=sender,
                message_count=count,
            ))

    db.commit()
