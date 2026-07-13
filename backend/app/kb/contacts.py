"""Extract and upsert contact profiles from a processed chat."""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.kb.models import Chat, Contact, ContactAppearance, Message


def extract_contacts(chat_id: int, workspace_id: int, db: Session) -> None:
    """
    Called after a chat finishes processing.
    Reads unique senders, upserts them into contacts + contact_appearances.
    Skips group chats — an individual group member isn't a 1:1 contact, and
    WhatsApp doesn't expose a friendly name for them anyway (only a raw ID),
    so extracting them just pollutes the Contacts page with meaningless numbers.
    """
    chat = db.get(Chat, chat_id)
    if chat is not None and chat.is_group:
        return

    rows = (
        db.query(
            Message.sender,
            func.count(Message.id).label("cnt"),
            func.max(Message.timestamp).label("last_seen"),
        )
        .filter(Message.chat_id == chat_id, Message.sender.isnot(None), Message.sender != "Me")
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

        appearance = (
            db.query(ContactAppearance)
            .filter(
                ContactAppearance.contact_id == contact.id,
                ContactAppearance.chat_id == chat_id,
            )
            .first()
        )

        if appearance is None:
            # First time this contact has been seen in this specific chat —
            # safe to count it.
            contact.chat_count += 1
            contact.message_count += count
            db.add(ContactAppearance(
                contact_id=contact.id,
                chat_id=chat_id,
                sender_name=sender,
                message_count=count,
            ))
        elif appearance.message_count != count:
            # Re-running extraction on a chat with genuinely new messages —
            # adjust by the delta only, don't re-add the full count again.
            contact.message_count += (count - appearance.message_count)
            appearance.message_count = count

        if last_seen and (not contact.last_seen or last_seen > contact.last_seen):
            contact.last_seen = last_seen

    db.commit()