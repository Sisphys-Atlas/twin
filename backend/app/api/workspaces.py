"""Workspace endpoints — one workspace = one WhatsApp number."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_owner
from app.kb.database import get_db
from app.kb.models import Chat, User, Workspace

router = APIRouter()


# ── Schemas ────────────────────────────────────────────────────────────────────

class WorkspaceOut(BaseModel):
    id:          int
    name:        str
    bridge_port: int
    phone_label: str | None
    chat_count:  int
    class Config: from_attributes = True


class CreateWorkspaceRequest(BaseModel):
    name:        str
    bridge_port: int = 3001
    phone_label: str | None = None


class PatchWorkspaceRequest(BaseModel):
    name:        str | None = None
    bridge_port: int | None = None
    phone_label: str | None = None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _fmt(ws: Workspace, db: Session) -> dict:
    chat_count = db.query(Chat).filter(
        Chat.workspace_id == ws.id, Chat.status == "done"
    ).count()
    return {
        "id":          ws.id,
        "name":        ws.name,
        "bridge_port": ws.bridge_port,
        "phone_label": ws.phone_label,
        "chat_count":  chat_count,
        "created_at":  ws.created_at.isoformat(),
    }


def _fmt_chat(c: Chat) -> dict:
    return {
        "job_id":            c.id,
        "original_filename": c.original_filename,
        "category":          c.category,
        "status":            c.status,
        "message_count":     c.message_count,
        "participants":      c.participant_names,
        "date_from":         c.date_from.isoformat() if c.date_from else None,
        "date_to":           c.date_to.isoformat()   if c.date_to   else None,
        "upload_time":       c.upload_time.isoformat() if c.upload_time else None,
    }


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/workspaces")
def list_workspaces(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
) -> list[dict]:
    return [_fmt(ws, db) for ws in db.query(Workspace).order_by(Workspace.id).all()]


@router.get("/workspace/default")
def get_or_create_default(
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    """Return the first (default) workspace, creating it if it doesn't exist."""
    ws = db.query(Workspace).first()
    if not ws:
        ws = Workspace(name="My Workspace", bridge_port=3001)
        db.add(ws)
        db.commit()
        db.refresh(ws)
    return _fmt(ws, db)


@router.post("/workspaces", status_code=201)
def create_workspace(
    req: CreateWorkspaceRequest,
    db:  Session = Depends(get_db),
    _:   User    = Depends(require_owner),
) -> dict:
    # Check port uniqueness
    existing = db.query(Workspace).filter(Workspace.bridge_port == req.bridge_port).first()
    if existing:
        raise HTTPException(400, f"Port {req.bridge_port} is already used by workspace \"{existing.name}\"")

    ws = Workspace(name=req.name, bridge_port=req.bridge_port, phone_label=req.phone_label)
    db.add(ws)
    db.commit()
    db.refresh(ws)
    return _fmt(ws, db)


@router.patch("/workspaces/{workspace_id}")
def patch_workspace(
    workspace_id: int,
    req: PatchWorkspaceRequest,
    db:  Session = Depends(get_db),
    _:   User    = Depends(require_owner),
) -> dict:
    ws = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not ws:
        raise HTTPException(404, "Workspace not found")

    if req.name        is not None: ws.name        = req.name
    if req.phone_label is not None: ws.phone_label = req.phone_label
    if req.bridge_port is not None:
        clash = db.query(Workspace).filter(
            Workspace.bridge_port == req.bridge_port,
            Workspace.id != workspace_id,
        ).first()
        if clash:
            raise HTTPException(400, f"Port {req.bridge_port} already used by \"{clash.name}\"")
        ws.bridge_port = req.bridge_port

    db.commit()
    db.refresh(ws)
    return _fmt(ws, db)


@router.delete("/workspaces/{workspace_id}", status_code=204)
def delete_workspace(
    workspace_id: int,
    db:  Session = Depends(get_db),
    _:   User    = Depends(require_owner),
):
    if workspace_id == 1:
        raise HTTPException(400, "Cannot delete the primary workspace")
    ws = db.query(Workspace).filter(Workspace.id == workspace_id).first()
    if not ws:
        raise HTTPException(404, "Workspace not found")
    db.delete(ws)
    db.commit()


@router.get("/workspaces/{workspace_id}/chats")
def list_workspace_chats(
    workspace_id: int,
    category: str | None = None,
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_user),
):
    q = db.query(Chat).filter(Chat.workspace_id == workspace_id)
    if category:
        q = q.filter(Chat.category == category)
    chats = q.order_by(Chat.upload_time.desc()).all()
    total_messages = sum(c.message_count for c in chats)
    done_count     = sum(1 for c in chats if c.status == "done")
    return {
        "workspace_id":   workspace_id,
        "total_chats":    len(chats),
        "done_chats":     done_count,
        "total_messages": total_messages,
        "chats":          [_fmt_chat(c) for c in chats],
    }
