from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.kb.database import get_db
from app.kb.models import Chat, User

router = APIRouter()

_STATUS_LABELS = {
    "pending":     "Queued",
    "parsing":     "Parsing messages…",
    "summarizing": "Summarizing threads…",
    "embedding":   "Generating embeddings…",
    "done":        "Ready",
    "error":       "Error",
}


@router.get("/status/{job_id}")
def get_status(job_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    chat = db.get(Chat, job_id)
    if not chat:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")

    return {
        "job_id": job_id,
        "status": chat.status,
        "status_label": _STATUS_LABELS.get(chat.status, chat.status),
        "original_filename": chat.original_filename,
        "category": chat.category,
        "workspace_id": chat.workspace_id,
        "message_count": chat.message_count,
        "participants": chat.participant_names,
        "date_from": chat.date_from.isoformat() if chat.date_from else None,
        "date_to": chat.date_to.isoformat() if chat.date_to else None,
        "upload_time": chat.upload_time.isoformat() if chat.upload_time else None,
        "error": chat.error_message,
    }


@router.get("/chats")
def list_chats(
    workspace_id: int | None = None,
    category: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """Return all done chats, optionally filtered by workspace and/or category."""
    q = db.query(Chat).filter(Chat.status == "done")
    if workspace_id is not None:
        q = q.filter(Chat.workspace_id == workspace_id)
    if category:
        q = q.filter(Chat.category == category)
    chats = q.order_by(Chat.upload_time.desc()).all()

    return {
        "chats": [
            {
                "job_id": c.id,
                "original_filename": c.original_filename,
                "category": c.category,
                "workspace_id": c.workspace_id,
                "message_count": c.message_count,
                "participants": c.participant_names,
                "date_from": c.date_from.isoformat() if c.date_from else None,
                "date_to": c.date_to.isoformat() if c.date_to else None,
                "upload_time": c.upload_time.isoformat() if c.upload_time else None,
            }
            for c in chats
        ]
    }
