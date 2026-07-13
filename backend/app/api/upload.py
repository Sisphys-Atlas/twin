import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import BRIDGE_SECRET, get_current_user
from app.kb.database import SessionLocal, get_db
from app.kb.models import Chat, Message, Thread, User

router = APIRouter()


def _bridge_or_user(request: Request, db: Session = Depends(get_db)) -> None:
    """Accept calls from the bridge (X-Bridge-Secret) OR an authenticated user."""
    secret = request.headers.get("X-Bridge-Secret", "")
    if secret == BRIDGE_SECRET:
        return
    get_current_user(request, db)  # Raises 401 if not authenticated

PREVIEW_LIMIT = 500

VALID_CATEGORIES = {"customer", "team", "supplier", "other"}


def _detect_lang(text: str) -> str | None:
    if not text or len(text.strip()) < 15:
        return None
    try:
        from langdetect import detect
        return detect(text)
    except Exception:
        return None


def _process_chat(
    chat_id: int,
    file_path: str | None,
    workspace_id: int | None,
    structured_messages: list[dict] | None = None,
) -> None:
    from app.parsing.whatsapp_parser import parse, from_structured

    db = SessionLocal()
    try:
        chat = db.get(Chat, chat_id)

        # ── Phase 1: parse + store messages ──────────────────────────────
        chat.status = "parsing"
        db.commit()

        if structured_messages is not None:
            # Caller (the WhatsApp bridge) already has structured message
            # data — skip the text-export regex parser entirely.
            result = from_structured(structured_messages)
        else:
            text = Path(file_path).read_text(encoding="utf-8-sig")
            result = parse(text)

        for msg in result.messages:
            db.add(Message(
                chat_id=chat_id,
                timestamp=msg.timestamp,
                sender=msg.sender,
                body=msg.body,
                message_type=msg.message_type,
                media_filename=msg.media_filename,
                burst_id=msg.burst_id,
                position_in_chat=msg.position,
                language=_detect_lang(msg.body) if msg.sender else None,
            ))

        chat.message_count = sum(1 for m in result.messages if m.sender)
        chat.participant_names = result.participants
        chat.date_from = result.date_from
        chat.date_to = result.date_to
        db.commit()

        if not settings.gemini_api_key:
            chat.status = "done"
            db.commit()
            if workspace_id:
                from app.kb.contacts import extract_contacts
                extract_contacts(chat_id, workspace_id, db)
            return

        # ── Phase 2: thread segmentation + summarisation ──────────────────
        from app.structuring.thread_analyzer import segment_threads, summarize_thread

        chat.status = "summarizing"
        db.commit()

        threads = segment_threads(result.messages)
        db_messages = db.query(Message).filter(Message.chat_id == chat_id).all()
        pos_map = {m.position_in_chat: m for m in db_messages}

        for i, thread_msgs in enumerate(threads):
            data = summarize_thread(thread_msgs)
            thread_rec = Thread(
                chat_id=chat_id,
                thread_index=i,
                start_time=thread_msgs[0].timestamp,
                end_time=thread_msgs[-1].timestamp,
                message_count=len(thread_msgs),
                summary=data.get("summary", ""),
                intent_tags=data.get("intent_tags", []),
                key_entities=data.get("key_entities", {}),
            )
            db.add(thread_rec)
            db.flush()
            for msg in thread_msgs:
                if msg.position in pos_map:
                    pos_map[msg.position].thread_id = thread_rec.id

        db.commit()

        # ── Phase 3: embeddings ───────────────────────────────────────────
        from app.kb.embeddings import embed_texts

        chat.status = "embedding"
        db.commit()

        real_msgs = [m for m in db_messages if m.sender and m.body]
        if real_msgs:
            embeddings = embed_texts([m.body for m in real_msgs])
            for m, emb in zip(real_msgs, embeddings):
                m.embedding = emb
            db.commit()

        thread_recs = db.query(Thread).filter(Thread.chat_id == chat_id).all()
        summaries = [t for t in thread_recs if t.summary]
        if summaries:
            t_embs = embed_texts([t.summary for t in summaries])
            for t, emb in zip(summaries, t_embs):
                t.embedding = emb
            db.commit()

        chat.status = "done"
        db.commit()

        # ── Phase 4: contact extraction ───────────────────────────────────
        if workspace_id:
            from app.kb.contacts import extract_contacts
            extract_contacts(chat_id, workspace_id, db)

    except Exception as exc:
        db.rollback()
        try:
            chat = db.get(Chat, chat_id)
            if chat:
                chat.status = "error"
                chat.error_message = str(exc)[:500]
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


class StructuredMessageIn(BaseModel):
    timestamp: int
    sender: str | None = None
    body: str = ""
    message_type: str = "text"


class ImportMessagesRequest(BaseModel):
    chat_name: str
    phone: str | None = None
    is_group: bool = False
    workspace_id: int | None = None
    category: str = "other"
    messages: list[StructuredMessageIn] = []


@router.post("/upload/import-messages")
async def import_messages(
    req: ImportMessagesRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _: None = Depends(_bridge_or_user),
):
    """Structured equivalent of /upload/parse — used by the WhatsApp bridge,
    which already has each message as a discrete object. Avoids the fragile
    text-export round trip (reconstruct .txt → re-parse with regex)."""
    category = req.category if req.category in VALID_CATEGORIES else "other"

    if not req.messages:
        raise HTTPException(status_code=422, detail="No messages provided.")

    original_filename = f"{req.chat_name}.txt"

    # Reuse the existing Chat row on re-sync instead of delete+recreate — the
    # row's id must stay stable across re-syncs, since ContactAppearance is
    # keyed by chat_id. Deleting and recreating made every re-sync look like
    # a brand new chat to extract_contacts, permanently inflating chat_count.
    chat = None
    if req.workspace_id:
        q = db.query(Chat).filter(Chat.workspace_id == req.workspace_id)
        if req.phone:
            chat = q.filter(Chat.phone == req.phone).first()
        if chat is None:
            # Phone didn't match (or wasn't provided) — WhatsApp's LID can
            # rotate between sessions for the same real contact, so always
            # fall back to matching by name rather than giving up.
            chat = q.filter(Chat.original_filename == original_filename).first()

    if chat is not None:
        # Clear old messages/threads (cascade-safe) but keep the same chat id
        # and its existing ContactAppearance/Contact links intact.
        db.query(Message).filter(Message.chat_id == chat.id).delete()
        db.query(Thread).filter(Thread.chat_id == chat.id).delete()
        chat.filename = original_filename
        chat.original_filename = original_filename
        chat.phone = req.phone
        chat.is_group = req.is_group
        chat.category = category
        chat.status = "pending"
        chat.message_count = 0
        db.commit()
    else:
        chat = Chat(
            filename=original_filename,
            original_filename=original_filename,
            phone=req.phone,
            is_group=req.is_group,
            workspace_id=req.workspace_id,
            category=category,
            status="pending",
        )
        db.add(chat)
        db.commit()
        db.refresh(chat)

    structured = [m.model_dump() for m in req.messages]
    background_tasks.add_task(_process_chat, chat.id, None, req.workspace_id, structured)

    return {
        "job_id": chat.id,
        "filename": original_filename,
        "category": category,
        "workspace_id": req.workspace_id,
        "message_count": len(req.messages),
    }


@router.post("/upload/parse")
async def upload_and_parse(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    workspace_id: int | None = Form(None),
    category: str = Form("other"),
    db: Session = Depends(get_db),
    _: None = Depends(_bridge_or_user),
):
    if not (file.filename or "").lower().endswith(".txt"):
        raise HTTPException(status_code=400, detail="Only .txt files are accepted.")

    if category not in VALID_CATEGORIES:
        category = "other"

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = raw.decode("utf-16")
        except UnicodeDecodeError:
            raise HTTPException(status_code=422, detail="Could not decode file. Expected UTF-8 or UTF-16.")

    from app.parsing.whatsapp_parser import parse
    result = parse(text)
    if not result.messages:
        raise HTTPException(
            status_code=422,
            detail=f"No messages parsed (format: {result.format_detected!r}). "
                   "Make sure this is a WhatsApp export.",
        )

    upload_dir = settings.storage_path / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    file_id = uuid.uuid4().hex
    saved_path = upload_dir / f"{file_id}.txt"
    saved_path.write_bytes(raw)

    # Delete any existing record for this chat so re-syncs replace instead of duplicate
    if workspace_id and file.filename:
        old = db.query(Chat).filter(
            Chat.workspace_id == workspace_id,
            Chat.original_filename == file.filename,
        ).first()
        if old:
            db.delete(old)
            db.commit()

    chat = Chat(
        filename=f"{file_id}.txt",
        original_filename=file.filename,
        workspace_id=workspace_id,
        category=category,
        status="pending",
    )
    db.add(chat)
    db.commit()
    db.refresh(chat)

    background_tasks.add_task(_process_chat, chat.id, str(saved_path), workspace_id)

    return {
        "job_id": chat.id,
        "filename": file.filename,
        "category": category,
        "workspace_id": workspace_id,
        "format_detected": result.format_detected,
        "stats": {
            "total_messages": len(result.messages),
            "non_system": sum(1 for m in result.messages if m.sender),
            "system": sum(1 for m in result.messages if not m.sender),
            "voice_notes": sum(1 for m in result.messages if m.message_type == "voice"),
            "images": sum(1 for m in result.messages if m.message_type == "image"),
            "participants": result.participants,
            "date_from": result.date_from.isoformat() if result.date_from else None,
            "date_to": result.date_to.isoformat() if result.date_to else None,
            "parse_errors": result.parse_errors,
        },
        "preview_capped": len(result.messages) > PREVIEW_LIMIT,
        "messages": [
            {
                "position": m.position,
                "timestamp": m.timestamp.isoformat(),
                "sender": m.sender,
                "body": m.body,
                "message_type": m.message_type,
                "media_filename": m.media_filename,
                "burst_id": m.burst_id,
            }
            for m in result.messages[:PREVIEW_LIMIT]
        ],
    }