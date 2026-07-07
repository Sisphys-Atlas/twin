"""WhatsApp bridge relay — proxies status/send/approve, handles inbound drafts."""

import re
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_assistant, require_owner, verify_bridge_secret
from app.kb.database import SessionLocal, get_db
from app.kb.models import User, Workspace

router = APIRouter()

_DEFAULT_BRIDGE_PORT = 3001


# ── Bridge URL resolution ───────────────────────────────────────────────────────

def _bridge_url_for_port(port: int) -> str:
    return f"http://localhost:{port}"


def get_bridge_url(request: Request, db: Session = Depends(get_db)) -> str:
    """FastAPI dependency — resolves bridge URL from X-Workspace-ID header."""
    try:
        ws_id = int(request.headers.get("X-Workspace-ID", "1"))
    except ValueError:
        ws_id = 1
    ws = db.query(Workspace).filter(Workspace.id == ws_id).first()
    port = ws.bridge_port if ws else _DEFAULT_BRIDGE_PORT
    return _bridge_url_for_port(port)


# ── Bridge proxy helpers ────────────────────────────────────────────────────────

async def _bridge_get(path: str, bridge_url: str = f"http://localhost:{_DEFAULT_BRIDGE_PORT}"):
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(f"{bridge_url}/{path}", timeout=4)
            return r.json()
        except Exception:
            return None


async def _bridge_post(path: str, body: dict, bridge_url: str = f"http://localhost:{_DEFAULT_BRIDGE_PORT}"):
    async with httpx.AsyncClient() as c:
        try:
            r = await c.post(f"{bridge_url}/{path}", json=body, timeout=12)
            return r.json()
        except Exception as e:
            return {"error": str(e)}


# ── Status & conversations (polled by frontend) ─────────────────────────────────

@router.get("/whatsapp/status")
async def whatsapp_status(
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
):
    data = await _bridge_get("status", bridge_url)
    if data is None:
        return {"connected": False, "qr": None, "error": "Bridge not running — start it with: cd bridge && npm start"}
    return data


@router.get("/whatsapp/conversations")
async def whatsapp_conversations(
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
):
    data = await _bridge_get("conversations", bridge_url)
    return data if data is not None else []


# ── Inbound — called by bridge when a customer message arrives ──────────────────

class InboundMessage(BaseModel):
    phone: str
    name: str
    body: str
    timestamp: int
    history: list[dict] = []
    bridge_port: int = 3001  # bridge includes its own port so we can resolve the workspace


@router.post("/whatsapp/inbound")
def whatsapp_inbound(
    msg: InboundMessage,
    bg: BackgroundTasks,
    db: Session = Depends(get_db),
    _: None = Depends(verify_bridge_secret),
):
    ws = db.query(Workspace).filter(Workspace.bridge_port == msg.bridge_port).first()
    workspace_id = ws.id if ws else 1
    bridge_url   = _bridge_url_for_port(msg.bridge_port)
    bg.add_task(_generate_and_push_draft, msg.phone, msg.name, msg.body, msg.timestamp, msg.history, workspace_id, bridge_url)
    return {"ok": True}


def _index_live_message(db, phone: str, name: str, body: str, timestamp_unix: int, workspace_id: int = 1):
    """Find or create a Chat for this contact and insert the message with embedding."""
    from app.kb.models import Chat, Message
    from app.kb.embeddings import embed_texts

    safe_name = re.sub(r'[<>:"/\\|?*]', '_', name)
    ts = datetime.fromtimestamp(timestamp_unix, tz=timezone.utc)

    # Try to find existing chat synced for this contact
    chat = (
        db.query(Chat)
        .filter(
            Chat.workspace_id == workspace_id,
            Chat.original_filename.ilike(f"{safe_name}.txt"),
        )
        .first()
    )

    if chat is None:
        chat = Chat(
            filename=f"live_{phone}.txt",
            original_filename=f"{name}.txt",
            workspace_id=workspace_id,
            category="customer",
            status="done",
            participant_names=["Me", name],
            message_count=0,
        )
        db.add(chat)
        db.flush()

    # Skip if already indexed (re-sync guard)
    exists = (
        db.query(Message)
        .filter(Message.chat_id == chat.id, Message.timestamp == ts, Message.sender == name)
        .first()
    )
    if exists:
        return

    try:
        embedding = embed_texts([body])[0] if body and body.strip() else None
    except Exception:
        embedding = None

    db.add(Message(
        chat_id=chat.id,
        timestamp=ts,
        sender=name,
        body=body,
        message_type="text",
        embedding=embedding,
    ))

    chat.message_count = (chat.message_count or 0) + 1
    chat.date_to = ts
    if chat.date_from is None:
        chat.date_from = ts

    db.commit()


def _generate_and_push_draft(
    phone: str, name: str, body: str, timestamp: int,
    history: list[dict],
    workspace_id: int = 1,
    bridge_url: str = f"http://localhost:{_DEFAULT_BRIDGE_PORT}",
):
    """Runs in background: index message, generate agent reply, push draft to bridge."""
    from app.api.agent import _stream

    db = SessionLocal()
    try:
        try:
            _index_live_message(db, phone, name, body, timestamp, workspace_id)
        except Exception as e:
            print(f"[whatsapp] live indexing failed for {phone}: {e}")

        full_text = ""
        for event in _stream(
            customer_message=body,
            customer_name=name,
            history=history,
            workspace_id=workspace_id,
            db=db,
            phone=phone,
        ):
            if event.get("type") == "chunk":
                full_text += event.get("text", "")

        if full_text:
            import httpx as _httpx
            _httpx.post(
                f"{bridge_url}/conversations/{phone}/draft",
                json={"reply": full_text},
                timeout=6,
            )
    except Exception as e:
        print(f"[whatsapp] draft generation failed for {phone}: {e}")
    finally:
        db.close()


# ── Connected / disconnected events from bridge ─────────────────────────────────

@router.post("/whatsapp/connected")
def whatsapp_connected(body: dict, _: None = Depends(verify_bridge_secret)):
    print(f"[whatsapp] bridge connected: {body}")
    return {"ok": True}


@router.post("/whatsapp/disconnected")
def whatsapp_disconnected(body: dict, _: None = Depends(verify_bridge_secret)):
    print(f"[whatsapp] bridge disconnected: {body.get('reason')}")
    return {"ok": True}


# ── Send & approve (called by frontend) ────────────────────────────────────────

class SendRequest(BaseModel):
    to: str
    message: str


def _extract_digits(s: str) -> str:
    """Strip everything except digits and leading +."""
    s = s.strip()
    digits = re.sub(r"[^\d]", "", s)
    prefix = "+" if s.startswith("+") else ""
    return prefix + digits


def _looks_like_phone(s: str) -> bool:
    """True if the string is primarily a phone number (≥6 digits after stripping formatting)."""
    digits = re.sub(r"[^\d]", "", s)
    return len(digits) >= 6


@router.post("/whatsapp/send")
async def whatsapp_send(
    req: SendRequest,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
):
    to = req.to.strip()

    resolved_name = to
    if _looks_like_phone(to):
        to = _extract_digits(to)
    else:
        resolved = await _bridge_get(f"contacts/resolve?name={to}", bridge_url)
        if not resolved or "error" in resolved:
            return {"error": f"Could not find a phone number for \"{to}\". Try using the number directly."}
        resolved_name = resolved.get("name", to)
        to = resolved["phone"]

    result = await _bridge_post("send", {"to": to, "message": req.message}, bridge_url)
    if result and result.get("ok"):
        result["resolved_name"] = resolved_name
        result["resolved_phone"] = to
    return result


@router.post("/whatsapp/approve/{phone}")
async def whatsapp_approve(
    phone: str,
    bg: BackgroundTasks,
    request: Request,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
    db: Session = Depends(get_db),
):
    result = await _bridge_post(f"conversations/{phone}/approve", {}, bridge_url)
    if result and result.get("ok") and result.get("sent_text"):
        try:
            ws_id = int(request.headers.get("X-Workspace-ID", "1"))
        except ValueError:
            ws_id = 1
        bg.add_task(_index_sent_reply, phone, result["sent_text"], ws_id)
    return result


def _index_sent_reply(phone: str, text: str, workspace_id: int = 1):
    db = SessionLocal()
    try:
        _index_live_message(db, phone, "Me", text, int(datetime.now(timezone.utc).timestamp()), workspace_id)
    except Exception as e:
        print(f"[whatsapp] sent reply indexing failed for {phone}: {e}")
    finally:
        db.close()


@router.post("/whatsapp/reject/{phone}")
async def whatsapp_reject(
    phone: str,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
):
    return await _bridge_post(f"conversations/{phone}/draft", {"reply": None}, bridge_url)


@router.post("/whatsapp/toggle/{phone}")
async def whatsapp_toggle_twin(
    phone: str,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
):
    return await _bridge_post(f"conversations/{phone}/twin", {}, bridge_url)


# ── Sync (import history from WhatsApp) ────────────────────────────────────────

class SyncRequest(BaseModel):
    category: str = "customer"


@router.get("/whatsapp/sync/status")
async def whatsapp_sync_status(
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
):
    data = await _bridge_get("sync/status", bridge_url)
    return data if data is not None else {"running": False, "error": "Bridge not running"}


@router.post("/whatsapp/sync/start")
async def whatsapp_sync_start(
    req: SyncRequest,
    _: User = Depends(require_owner),
    bridge_url: str = Depends(get_bridge_url),
):
    return await _bridge_post("sync/start", {"category": req.category}, bridge_url)


# ── Demo mode ──────────────────────────────────────────────────────────────────

@router.post("/whatsapp/demo/sync")
async def whatsapp_demo_sync(
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
):
    """Start a demo sync using fake data — no WhatsApp connection required."""
    return await _bridge_post("demo/sync", {}, bridge_url)


@router.post("/whatsapp/{phone}/draft")
async def whatsapp_update_draft(
    phone: str,
    body: dict,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
):
    """Update the draft text for a conversation (used by edit-then-approve flow)."""
    return await _bridge_post(f"conversations/{phone}/draft", body, bridge_url)
