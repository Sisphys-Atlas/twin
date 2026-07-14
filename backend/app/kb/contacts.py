"""Extract and upsert contact profiles from a processed chat."""

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.kb.models import Chat, Contact, ContactAppearance, Message


def extract_contacts(chat_id: int, workspace_id: int, db: Session) -> None:
    """
    Called after a chat finishes processing.
    Identifies the contact by PHONE NUMBER, not by name — a chat's phone is
    stable, but the sender name recorded on individual messages can vary (a
    saved contact name, a self-set WhatsApp pushname, or a chat label from a
    different import session), which previously caused the same real person
    to be split into multiple separate Contact entries.
    Skips group chats — an individual group member isn't a 1:1 contact.
    Skips chats with no known phone — nothing stable to key identity on yet
    (run the phone backfill for chats imported before phone tracking existed).
    """
    chat = db.get(Chat, chat_id)
    if chat is None or chat.is_group or not chat.phone:
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
    if not rows:
        return

    total_count = sum(r.cnt for r in rows)
    last_seen = max((r.last_seen for r in rows if r.last_seen), default=None)

    # Prefer the chat's own saved name; fall back to whichever sender name
    # appeared most often across this chat's messages.
    chat_name = (chat.original_filename or "").removesuffix(".txt").strip() or None
    best_sender = max(rows, key=lambda r: r.cnt).sender
    display_name = chat_name or best_sender

    contact = (
        db.query(Contact)
        .filter(Contact.workspace_id == workspace_id, Contact.phone == chat.phone)
        .first()
    )
    if not contact:
        contact = Contact(
            workspace_id=workspace_id,
            phone=chat.phone,
            display_name=display_name,
            message_count=0,
            chat_count=0,
        )
        db.add(contact)
        db.flush()
    else:
        contact.display_name = display_name  # keep it current if it changed

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
        contact.message_count += total_count
        db.add(ContactAppearance(
            contact_id=contact.id,
            chat_id=chat_id,
            sender_name=display_name,
            message_count=total_count,
        ))
    elif appearance.message_count != total_count:
        # Re-running extraction on a chat with genuinely new messages —
        # adjust by the delta only, don't re-add the full count again.
        contact.message_count += (total_count - appearance.message_count)
        appearance.message_count = total_count

    if last_seen and (not contact.last_seen or last_seen > contact.last_seen):
        contact.last_seen = last_seen

    db.commit()