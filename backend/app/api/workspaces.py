"""Workspace endpoints — one workspace = one WhatsApp number."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import BRIDGE_SECRET, get_current_user, require_owner
from app.kb.database import get_db
from app.kb.models import Chat, User, Workspace

router = APIRouter()


def _bridge_or_user(request: Request, db: Session = Depends(get_db)) -> None:
    """Accept calls from the bridge (X-Bridge-Secret) OR an authenticated user.
    The bridge is a plain Node process with no login session, so any endpoint
    it calls directly (like resolving the default workspace) needs this."""
    secret = request.headers.get("X-Bridge-Secret", "")
    if secret == BRIDGE_SECRET:
        return
    get_current_user(request, db)  # Raises 401 if not authenticated



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
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_user),
) -> list[dict]:
    q = db.query(Workspace)
    if user.role != "superadmin":
        q = q.filter(Workspace.tenant_id == user.tenant_id)
    return [_fmt(ws, db) for ws in q.order_by(Workspace.id).all()]


@router.get("/workspace/default")
def get_or_create_default(
    request: Request,
    db: Session = Depends(get_db),
):
    """Return the caller's default workspace, creating it if it doesn't exist.
    For a logged-in user this is the first workspace of THEIR tenant — not the
    first workspace in the database, which belongs to whichever tenant was
    created first. The bridge (X-Bridge-Secret) has no tenant; it gets the
    global first workspace as before."""
    secret = request.headers.get("X-Bridge-Secret", "")
    if secret == BRIDGE_SECRET:
        ws = db.query(Workspace).order_by(Workspace.id).first()
    else:
        user = get_current_user(request, db)
        q = db.query(Workspace)
        if user.role != "superadmin":
            q = q.filter(Workspace.tenant_id == user.tenant_id)
        ws = q.order_by(Workspace.id).first()
        if not ws:
            max_port = db.query(Workspace).order_by(Workspace.bridge_port.desc()).first()
            ws = Workspace(name="My Workspace", bridge_port=(max_port.bridge_port + 1) if max_port else 3001, tenant_id=user.tenant_id)
            db.add(ws)
            db.commit()
            db.refresh(ws)
    if not ws:
        ws = Workspace(name="My Workspace", bridge_port=3001)
        db.add(ws)
        db.commit()
        db.refresh(ws)
    return _fmt(ws, db)


@router.get("/workspace/by-port/{port}")
def get_workspace_by_port(
    port: int,
    db: Session = Depends(get_db),
    _:  None    = Depends(_bridge_or_user),
):
    """Resolve a workspace by its bridge_port — used by each bridge instance
    to correctly identify ITS OWN workspace, instead of always resolving to
    the first/default one (which is wrong for any second or third number)."""
    ws = db.query(Workspace).filter(Workspace.bridge_port == port).first()
    if not ws:
        ws = db.query(Workspace).first()
    if not ws:
        ws = Workspace(name="My Workspace", bridge_port=port)
        db.add(ws)
        db.commit()
        db.refresh(ws)
    return _fmt(ws, db)


@router.post("/workspaces", status_code=201)
def create_workspace(
    req:  CreateWorkspaceRequest,
    db:   Session = Depends(get_db),
    user: User    = Depends(require_owner),
) -> dict:
    # Check port uniqueness
    existing = db.query(Workspace).filter(Workspace.bridge_port == req.bridge_port).first()
    if existing:
        raise HTTPException(400, f"Port {req.bridge_port} is already used by workspace \"{existing.name}\"")

    ws = Workspace(name=req.name, bridge_port=req.bridge_port, phone_label=req.phone_label, tenant_id=user.tenant_id)
    db.add(ws)
    db.commit()
    db.refresh(ws)
    return _fmt(ws, db)


@router.patch("/workspaces/{workspace_id}")
def patch_workspace(
    workspace_id: int,
    req:  PatchWorkspaceRequest,
    db:   Session = Depends(get_db),
    user: User    = Depends(require_owner),
) -> dict:
    q = db.query(Workspace).filter(Workspace.id == workspace_id)
    if user.role != "superadmin":
        q = q.filter(Workspace.tenant_id == user.tenant_id)
    ws = q.first()
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
    db:   Session = Depends(get_db),
    user: User    = Depends(require_owner),
):
    q = db.query(Workspace).filter(Workspace.id == workspace_id)
    if user.role != "superadmin":
        q = q.filter(Workspace.tenant_id == user.tenant_id)
    ws = q.first()
    if not ws:
        raise HTTPException(404, "Workspace not found")
    # Prevent deleting the last workspace for this tenant
    sibling_count = db.query(Workspace).filter(Workspace.tenant_id == ws.tenant_id).count()
    if sibling_count <= 1:
        raise HTTPException(400, "Cannot delete the last workspace")

    # Kill the bridge + WhatsApp session and hard-delete this number's chats
    # (the FK would only orphan them with workspace_id = NULL)
    from app.api.whatsapp import teardown_workspace_bridge
    teardown_workspace_bridge(ws)
    db.query(Chat).filter(Chat.workspace_id == ws.id).delete(synchronize_session=False)

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