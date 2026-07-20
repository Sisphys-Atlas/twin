"""WhatsApp bridge relay — proxies status/send/approve, handles inbound drafts."""

import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import get_current_user, require_assistant, require_owner, require_superadmin, verify_bridge_secret
from app.kb.database import SessionLocal, get_db
from app.kb.models import Chat, User, Workspace

router = APIRouter()

_DEFAULT_BRIDGE_PORT = 3001


# ── Bridge URL resolution ───────────────────────────────────────────────────────

def _bridge_url_for_port(port: int) -> str:
    return f"http://localhost:{port}"


def get_workspace(request: Request, db: Session = Depends(get_db)) -> Workspace | None:
    """Resolve the workspace from the X-Workspace-ID header, ENFORCING tenant
    ownership. A header pointing at another tenant's workspace (or the old
    default of 1) silently resolves to the caller's own first workspace —
    a client must never reach someone else's bridge, whatever they send."""
    user = get_current_user(request, db)  # 401 if not logged in

    try:
        ws_id = int(request.headers.get("X-Workspace-ID", "0"))
    except ValueError:
        ws_id = 0

    scoped = db.query(Workspace)
    if user.role != "superadmin":
        scoped = scoped.filter(Workspace.tenant_id == user.tenant_id)

    ws = scoped.filter(Workspace.id == ws_id).first() if ws_id else None
    if ws is None:
        # Fall back to the caller's own first workspace — never a global default
        fallback = db.query(Workspace)
        if user.role != "superadmin":
            fallback = fallback.filter(Workspace.tenant_id == user.tenant_id)
        ws = fallback.order_by(Workspace.id).first()
    return ws


def get_bridge_url(request: Request, db: Session = Depends(get_db)) -> str:
    """FastAPI dependency — tenant-scoped bridge URL resolution."""
    ws = get_workspace(request, db)
    port = ws.bridge_port if ws else _DEFAULT_BRIDGE_PORT
    return _bridge_url_for_port(port)


# ── Bridge auto-start ────────────────────────────────────────────────────────────
# Spawns a bridge process for a workspace on demand, so the owner never has to
# manually open a terminal and run `BRIDGE_PORT=XXXX node index.js` for every
# number they add. Only sensible for local/single-machine setups (backend and
# bridge on the same filesystem) — disable with BRIDGE_AUTO_START=false.

_bridge_processes: dict[int, subprocess.Popen] = {}   # workspace_id -> process
_bridge_last_spawn: dict[int, float] = {}              # workspace_id -> unix time
_SPAWN_COOLDOWN_SECONDS = 8  # avoid re-spawning while a just-started bridge is still booting


def _resolve_bridge_dir() -> Path | None:
    d = settings.bridge_dir
    if not d.is_absolute():
        # backend/app/api/whatsapp.py -> backend/app/api -> backend/app -> backend/
        backend_root = Path(__file__).resolve().parent.parent.parent
        d = (backend_root / d).resolve()
    return d if (d / "index.js").exists() else None


def _kill_port(port: int) -> None:
    """Best-effort: kill whatever process is listening on a local port."""
    try:
        if os.name == "nt":
            r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10)
            for line in r.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    subprocess.run(["taskkill", "/PID", line.split()[-1], "/F"], capture_output=True, timeout=10)
        else:
            subprocess.run(["fuser", "-k", f"{port}/tcp"], capture_output=True, timeout=10)
    except Exception as e:
        print(f"[whatsapp] port kill failed for {port}: {e}")


def _probe_bridge(port: int) -> dict | None:
    """Return the /status payload if a Twin bridge answers on this port,
    else None. Identifies bridges by their status shape, so a random dev
    server on the port isn't mistaken for one."""
    try:
        r = httpx.get(f"http://localhost:{port}/status", timeout=1.5)
        d = r.json()
        if isinstance(d, dict) and "connected" in d and "qr" in d:
            return d
    except Exception:
        pass
    return None


def ensure_bridge_running(ws: Workspace | None) -> None:
    """Best-effort: spawn a bridge process for this workspace's port if one
    isn't already tracked as running. Non-blocking — caller should retry the
    actual bridge request a moment later if this was just spawned."""
    if not settings.bridge_auto_start or ws is None:
        return

    proc = _bridge_processes.get(ws.id)
    if proc is not None and proc.poll() is None:
        return  # already running

    # A bridge may already be listening that we didn't spawn (started before
    # a backend restart, or run manually) — adopt it instead of colliding.
    if _probe_bridge(ws.bridge_port) is not None:
        return

    last = _bridge_last_spawn.get(ws.id, 0)
    if time.time() - last < _SPAWN_COOLDOWN_SECONDS:
        return  # just tried — give it time to boot before retrying

    bridge_dir = _resolve_bridge_dir()
    if bridge_dir is None:
        attempted = settings.bridge_dir
        if not attempted.is_absolute():
            attempted = (Path(__file__).resolve().parent.parent.parent / attempted).resolve()
        print(f"[whatsapp] bridge_dir not found (looked in {attempted}) — cannot auto-start bridge for workspace {ws.id}. Set BRIDGE_DIR in backend/.env if bridge/ is somewhere else.")
        return

    _bridge_last_spawn[ws.id] = time.time()

    log_path = bridge_dir / f".bridge-{ws.bridge_port}.log"
    try:
        log_file = open(log_path, "a")
        env = {**os.environ, "BRIDGE_PORT": str(ws.bridge_port), "WORKSPACE_ID": str(ws.id)}
        proc = subprocess.Popen(
            ["node", "index.js"],
            cwd=str(bridge_dir),
            env=env,
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
        )
        _bridge_processes[ws.id] = proc
        print(f"[whatsapp] auto-started bridge for workspace {ws.id} on port {ws.bridge_port} (pid {proc.pid}, log: {log_path})")
    except Exception as e:
        print(f"[whatsapp] failed to auto-start bridge for workspace {ws.id}: {e}")


def teardown_workspace_bridge(ws: Workspace) -> None:
    """Kill the bridge process for this workspace's port and destroy its
    WhatsApp session files. Called when a workspace or tenant is deleted —
    a removed client's WhatsApp must not stay logged in on our machine."""
    import shutil

    # 1. Kill the process this backend spawned (if any)
    proc = _bridge_processes.pop(ws.id, None)
    if proc is not None and proc.poll() is None:
        try:
            proc.kill()
        except Exception:
            pass

    # 2. Best-effort: kill anything else still listening on the port —
    #    bridges spawned before the last backend restart aren't tracked
    _kill_port(ws.bridge_port)

    # 3. Delete the WhatsApp session folder — the client's login credentials
    #    (both naming schemes: ws-keyed current, port-keyed legacy)
    bridge_dir = _resolve_bridge_dir()
    if bridge_dir is not None:
        for name in (f"session-ws-{ws.id}", f"session-port-{ws.bridge_port}"):
            session_dir = bridge_dir / ".wwebjs_auth" / name
            if session_dir.exists():
                try:
                    shutil.rmtree(session_dir)
                    print(f"[whatsapp] deleted WhatsApp session {name}")
                except Exception as e:
                    print(f"[whatsapp] session delete failed for {name}: {e}")


def reconcile_bridges() -> None:
    """Periodic fleet reconciliation — the DB is the registry of which bridges
    should exist. Spawns missing ones, executes zombies (a bridge whose
    workspace was deleted, or that serves a different workspace than the DB
    maps to its port). Zombie session FILES are left on disk on purpose: a
    linked session is hard to win back, and explicit workspace/tenant deletion
    is the path that destroys files."""
    if not settings.bridge_auto_start:
        return

    db = SessionLocal()
    try:
        workspaces = db.query(Workspace).all()
    finally:
        db.close()

    by_port = {w.bridge_port: w for w in workspaces}

    # 1) every workspace gets a bridge (idle bridges are cheap — no Chrome
    #    until someone actually connects)
    for w in workspaces:
        try:
            ensure_bridge_running(w)
        except Exception as e:
            print(f"[whatsapp] reconciler spawn failed for workspace {w.id}: {e}")

    # 2) zombie hunt across the bridge port range
    scan_max = (max(by_port) if by_port else _DEFAULT_BRIDGE_PORT) + 5
    for port in range(_DEFAULT_BRIDGE_PORT, scan_max + 1):
        status = _probe_bridge(port)
        if status is None:
            continue
        ws = by_port.get(port)
        reported = status.get("workspace_id")  # None on legacy bridges — trusted by port
        if ws is None or (reported is not None and reported != ws.id):
            print(f"[whatsapp] reconciler: killing zombie bridge on port {port} "
                  f"(reports workspace {reported}, expected {ws.id if ws else 'none'})")
            _kill_port(port)


@router.get("/whatsapp/bridges")
def whatsapp_bridges(
    db: Session = Depends(get_db),
    _: User = Depends(require_superadmin),
) -> list[dict]:
    """Fleet overview — one row per workspace with the live bridge state."""
    out = []
    for w in db.query(Workspace).order_by(Workspace.id).all():
        status = _probe_bridge(w.bridge_port)
        if status is None:
            state, phone = "down", None
        elif status.get("connected"):
            state, phone = "connected", (status.get("phone") or {}).get("number")
        elif status.get("qr"):
            state, phone = "qr_waiting", None
        elif status.get("waiting"):
            state, phone = "idle", None
        else:
            state, phone = "starting", None
        out.append({
            "workspace_id": w.id,
            "name":         w.name,
            "tenant_id":    w.tenant_id,
            "port":         w.bridge_port,
            "state":        state,
            "phone":        phone,
            "identity_ok":  status is None or status.get("workspace_id") in (None, w.id),
        })
    return out


# ── Bridge proxy helpers ────────────────────────────────────────────────────────

async def _bridge_get(path: str, bridge_url: str = f"http://localhost:{_DEFAULT_BRIDGE_PORT}", timeout: float = 4):
    async with httpx.AsyncClient() as c:
        try:
            r = await c.get(f"{bridge_url}/{path}", timeout=timeout)
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
    ws: Workspace | None = Depends(get_workspace),
):
    data = await _bridge_get("status", bridge_url)
    if data is None:
        ensure_bridge_running(ws)
        return {"connected": False, "qr": None, "error": "Starting bridge for this number…"}
    # Identity check — never present a different workspace's bridge as ours.
    # The reconciler will kill the misplaced bridge within its next pass.
    if ws is not None and data.get("workspace_id") not in (None, ws.id):
        return {"connected": False, "qr": None, "error": "Bridge mismatch for this number — fixing automatically, retry in a moment…"}
    return data


@router.post("/whatsapp/connect")
async def whatsapp_connect(
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
    ws: Workspace | None = Depends(get_workspace),
):
    """Tell the bridge to start the WhatsApp client (generates the QR).
    The bridge stays idle until this is called for a never-linked number."""
    data = await _bridge_post("connect", {}, bridge_url)
    if not data or data.get("error"):
        ensure_bridge_running(ws)
        return {"ok": False, "error": "Starting bridge for this number…"}
    return data


@router.get("/whatsapp/inbox/rehydrate")
async def whatsapp_inbox_rehydrate(
    workspace_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(verify_bridge_secret),
):
    """Called by the bridge on startup to rebuild its in-memory inbox from
    already-imported chats — without this, every bridge restart wipes the
    visible Inbox even though nothing was actually lost in the database."""
    from app.kb.models import Message

    chats = (
        db.query(Chat)
        .filter(Chat.workspace_id == workspace_id, Chat.is_group.is_(False), Chat.phone.isnot(None))
        .all()
    )

    result = []
    for chat in chats:
        msgs = (
            db.query(Message)
            .filter(Message.chat_id == chat.id, Message.sender.isnot(None))
            .order_by(Message.timestamp.asc())
            .limit(30)
            .all()
        )
        if not msgs:
            continue
        name = (chat.original_filename or chat.phone).removesuffix(".txt")
        result.append({
            "phone": chat.phone,
            "name": name,
            "category": chat.category,
            "messages": [
                {"sender": m.sender, "body": m.body or "", "timestamp": m.timestamp.isoformat()}
                for m in msgs
            ],
        })

    return result


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


# ── Live message persistence (Tier 1) — every message lands in the KB ──────────

class LiveMessageIn(BaseModel):
    direction: str = "in"          # "in" = customer, "out" = owner/agent
    body: str = ""
    message_type: str = "text"
    timestamp: int
    media_filename: str | None = None
    wa_message_id: str | None = None


class PersistMessagesRequest(BaseModel):
    phone: str
    name: str
    bridge_port: int = 3001
    messages: list[LiveMessageIn] = []


@router.post("/whatsapp/messages")
def whatsapp_persist_messages(
    req: PersistMessagesRequest,
    db: Session = Depends(get_db),
    _: None = Depends(verify_bridge_secret),
):
    """Called by the bridge for every live message (inbound AND outbound,
    including replies typed on the phone) and for reconnect backfill. The
    database is the source of truth — the bridge's memory is just a cache.
    Idempotent via wa_message_id, so re-sending the same messages is safe."""
    if not req.messages:
        return {"ok": True, "inserted": 0}

    ws = db.query(Workspace).filter(Workspace.bridge_port == req.bridge_port).first()
    workspace_id = ws.id if ws else 1

    chat = _get_or_create_live_chat(db, req.phone, req.name, workspace_id)
    inserted = 0
    for m in req.messages:
        try:
            if _insert_live_message(
                db, chat, req.name, m.body, m.timestamp,
                direction=m.direction, message_type=m.message_type,
                media_filename=m.media_filename, wa_message_id=m.wa_message_id,
            ):
                inserted += 1
        except Exception as e:
            db.rollback()
            print(f"[whatsapp] persist failed for {req.phone}: {e}")

    if inserted:
        try:
            from app.kb.contacts import extract_contacts
            extract_contacts(chat.id, workspace_id, db)
        except Exception as e:
            print(f"[whatsapp] contact extraction failed for chat {chat.id}: {e}")

    return {"ok": True, "inserted": inserted, "chat_id": chat.id}


def _get_or_create_live_chat(db, phone: str, name: str, workspace_id: int):
    """Find the Chat row for this contact — by phone first (stable), falling
    back to name for chats that predate phone tracking — creating it if new."""
    from app.kb.models import Chat

    safe_name = re.sub(r'[<>:"/\\|?*]', '_', name)

    chat = (
        db.query(Chat)
        .filter(Chat.workspace_id == workspace_id, Chat.phone == phone)
        .first()
    )
    if chat is None:
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
            phone=phone,
            workspace_id=workspace_id,
            category="customer",
            status="done",
            participant_names=["Me", name],
            message_count=0,
        )
        db.add(chat)
        db.flush()
    elif not chat.phone:
        chat.phone = phone  # backfill for chats created before phone tracking

    return chat


def _insert_live_message(
    db, chat, name: str, body: str, timestamp_unix: int,
    direction: str = "in", message_type: str = "text",
    media_filename: str | None = None, wa_message_id: str | None = None,
) -> bool:
    """Insert one live message into the KB, idempotently. Returns True if a
    row was actually inserted (False = duplicate, skipped)."""
    from app.kb.models import Message
    from app.kb.embeddings import embed_texts

    ts     = datetime.fromtimestamp(timestamp_unix, tz=timezone.utc)
    sender = "Me" if direction == "out" else name

    # Dedup — WhatsApp's message id is the strongest key (backfill re-sends
    # the same recent messages on every reconnect); fall back to
    # (timestamp, sender, body) for rows that predate wa_message_id.
    exists = None
    if wa_message_id:
        exists = (
            db.query(Message)
            .filter(Message.chat_id == chat.id, Message.wa_message_id == wa_message_id)
            .first()
        )
    if exists is None:
        exists = (
            db.query(Message)
            .filter(
                Message.chat_id == chat.id,
                Message.timestamp == ts,
                Message.sender == sender,
                Message.body == body,
            )
            .first()
        )
    if exists is not None:
        if wa_message_id and not exists.wa_message_id:
            exists.wa_message_id = wa_message_id  # heal old rows so wa-id dedup works next time
            db.commit()
        return False

    try:
        embedding = embed_texts([body])[0] if body and body.strip() and message_type == "text" else None
    except Exception:
        embedding = None

    db.add(Message(
        chat_id=chat.id,
        timestamp=ts,
        sender=sender,
        body=body,
        message_type=message_type,
        media_filename=media_filename,
        wa_message_id=wa_message_id,
        embedding=embedding,
    ))

    chat.message_count = (chat.message_count or 0) + 1
    if chat.date_to is None or ts > chat.date_to:
        chat.date_to = ts
    if chat.date_from is None:
        chat.date_from = ts

    db.commit()
    return True


def _index_live_message(db, phone: str, name: str, body: str, timestamp_unix: int, workspace_id: int = 1):
    """Find or create a Chat for this contact and insert the message with embedding."""
    chat = _get_or_create_live_chat(db, phone, name, workspace_id)
    if not _insert_live_message(db, chat, name, body, timestamp_unix):
        return

    try:
        from app.kb.contacts import extract_contacts
        extract_contacts(chat.id, workspace_id, db)
    except Exception as e:
        print(f"[whatsapp] contact extraction failed for chat {chat.id}: {e}")


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
        _maybe_update_style(workspace_id, db)
    except Exception as e:
        print(f"[whatsapp] sent reply indexing failed for {phone}: {e}")
    finally:
        db.close()


def _maybe_update_style(workspace_id: int, db):
    """Increment approved-reply counter; re-learn style every 10 approvals."""
    from app.api.style import load_style, save_style, _run_learn
    profile = load_style() or {}
    count = profile.get("approved_since_last_learn", 0) + 1
    if count >= 10:
        print(f"[style] {count} approved replies — triggering background re-learn")
        try:
            _run_learn(workspace_id, db)
        except Exception as e:
            print(f"[style] background re-learn failed: {e}")
            profile["approved_since_last_learn"] = count
            save_style(profile)
    else:
        profile["approved_since_last_learn"] = count
        save_style(profile)


@router.post("/whatsapp/reject/{phone}")
async def whatsapp_reject(
    phone: str,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
):
    return await _bridge_post(f"conversations/{phone}/draft", {"reply": None}, bridge_url)


@router.post("/whatsapp/regenerate/{phone}")
async def whatsapp_regenerate(
    phone: str,
    bg: BackgroundTasks,
    request: Request,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
):
    """Discard the current draft (if any) and ask the AI to write a new one
    from the existing conversation history — used by the Discard/Regenerate
    flow in the inbox when there's no new incoming message to react to."""
    conv = await _bridge_get(f"conversations/{phone}", bridge_url)
    if not conv or not conv.get("messages"):
        raise HTTPException(404, "Conversation not found or has no messages")

    last_customer_msg = next(
        (m for m in reversed(conv["messages"]) if m.get("role") == "customer"), None
    )
    if not last_customer_msg:
        raise HTTPException(400, "No customer message to reply to")

    try:
        ws_id = int(request.headers.get("X-Workspace-ID", "1"))
    except ValueError:
        ws_id = 1

    # Clear the old draft immediately so the frontend shows "Generating…"
    await _bridge_post(f"conversations/{phone}/draft", {"reply": None}, bridge_url)

    timestamp = int(datetime.fromisoformat(last_customer_msg["timestamp"]).timestamp())
    bg.add_task(
        _generate_and_push_draft,
        phone, conv.get("name", phone), last_customer_msg["content"], timestamp,
        conv["messages"][-20:], ws_id, bridge_url,
    )
    return {"ok": True}


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
    phones: list[str] | None = None  # if set, only import these contacts


@router.get("/whatsapp/sync/status")
async def whatsapp_sync_status(
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
):
    data = await _bridge_get("sync/status", bridge_url)
    return data if data is not None else {"running": False, "error": "Bridge not running"}


@router.get("/whatsapp/sync/chats")
async def whatsapp_sync_chats(
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
):
    """List available WhatsApp chats (lightweight, no message history) so the
    owner can pick which contacts to import before starting a sync."""
    # Chat listing walks every chat sequentially in the bridge — can take
    # well over the default 4s with a real account, so give it room.
    data = await _bridge_get("sync/chats", bridge_url, timeout=60)
    if data is None:
        raise HTTPException(503, "Bridge not running")
    if isinstance(data, dict) and "error" in data:
        raise HTTPException(400, data["error"])
    return data


@router.post("/whatsapp/sync/backfill-phones")
async def whatsapp_backfill_phones(
    db: Session = Depends(get_db),
    _: User = Depends(require_owner),
    bridge_url: str = Depends(get_bridge_url),
    ws: Workspace | None = Depends(get_workspace),
):
    """One-time fix for chats imported before phone/group tracking existed —
    matches every chat to the bridge's current chat list by phone (or name as
    a fallback) and fills in Chat.phone + Chat.is_group. Also removes any
    Contact rows that turn out to be group-member IDs now that we know
    which chats are actually groups, then re-runs extraction so the Contacts
    page reflects the corrected data immediately."""
    from app.kb.contacts import extract_contacts
    from app.kb.models import Contact

    ws_id = ws.id if ws else 1

    bridge_chats = await _bridge_get("sync/chats", bridge_url)
    if not isinstance(bridge_chats, list):
        raise HTTPException(503, "Bridge not running or unreachable")

    phone_to_group = {bc["phone"]: bc.get("isGroup", False) for bc in bridge_chats if bc.get("phone")}
    name_to_bc = {bc["name"]: bc for bc in bridge_chats if bc.get("name")}

    chats = db.query(Chat).filter(Chat.workspace_id == ws_id).all()
    matched = 0
    newly_group = []
    for chat in chats:
        bc = None
        if chat.phone and chat.phone in phone_to_group:
            bc = {"phone": chat.phone, "isGroup": phone_to_group[chat.phone]}
        else:
            name = (chat.original_filename or "").removesuffix(".txt")
            bc = name_to_bc.get(name)

        if not bc:
            continue
        matched += 1
        if not chat.phone and bc.get("phone"):
            chat.phone = bc["phone"]
        was_group = chat.is_group
        chat.is_group = bool(bc.get("isGroup", False))
        if chat.is_group and not was_group:
            newly_group.append(chat.id)

    db.commit()

    # Remove Contact rows that only exist because of chats we now know are
    # groups (raw numeric IDs from group members, not real 1:1 contacts).
    deleted = 0
    if newly_group:
        junk = db.query(Contact).filter(
            Contact.workspace_id == ws_id,
            Contact.display_name.op("~")("^[0-9]+$"),
        ).all()
        for c in junk:
            db.delete(c)
            deleted += 1
        db.commit()

        # Re-run extraction for every non-group chat so message_count/appearances
        # reflect the correction (chats that were group-tagged just now are
        # correctly skipped by extract_contacts going forward).
        for chat in db.query(Chat).filter(Chat.workspace_id == ws_id, Chat.is_group.is_(False)).all():
            try:
                extract_contacts(chat.id, ws_id, db)
            except Exception:
                pass

    return {"chats_checked": len(chats), "matched": matched, "newly_marked_group": len(newly_group), "junk_contacts_removed": deleted}


@router.post("/whatsapp/sync/start")
async def whatsapp_sync_start(
    req: SyncRequest,
    _: User = Depends(require_owner),
    bridge_url: str = Depends(get_bridge_url),
):
    body = {"category": req.category}
    if req.phones:
        body["phones"] = req.phones
    return await _bridge_post("sync/start", body, bridge_url)


class AddContactRequest(BaseModel):
    phone: str
    category: str = "other"


@router.post("/whatsapp/sync/chat")
async def whatsapp_sync_chat(
    req: AddContactRequest,
    _: User = Depends(require_assistant),
    bridge_url: str = Depends(get_bridge_url),
):
    """Import a single contact's chat history on demand — used by the
    Contacts page's "Add to chat" button for contacts that weren't picked
    during the original bulk import."""
    data = await _bridge_post("sync/chat", {"phone": req.phone, "category": req.category}, bridge_url)
    if isinstance(data, dict) and "error" in data:
        raise HTTPException(400, data["error"])
    return data


@router.get("/whatsapp/contacts/all")
async def whatsapp_contacts_all(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
    bridge_url: str = Depends(get_bridge_url),
    ws: Workspace | None = Depends(get_workspace),
):
    """Merged view for the Contacts page: real imported contacts (with
    message history) plus WhatsApp chats that haven't been imported yet, so
    the owner can bring individual contacts in on demand instead of only
    through the bulk sync picker."""
    from app.kb.models import Contact

    ws_id = ws.id if ws else 1

    imported_phones = {
        row[0] for row in db.query(Chat.phone)
        .filter(Chat.workspace_id == ws_id, Chat.phone.isnot(None))
        .all()
    }

    contacts = db.query(Contact).filter(Contact.workspace_id == ws_id).all()
    imported = [{
        "id": c.id,
        "display_name": c.display_name,
        "message_count": c.message_count,
        "chat_count": c.chat_count,
        "last_seen": c.last_seen.isoformat() if c.last_seen else None,
        "notes": c.notes,
        "tags": c.tags or [],
        "imported": True,
    } for c in contacts]

    available = []
    bridge_chats = await _bridge_get("sync/chats", bridge_url)
    if isinstance(bridge_chats, list):
        for bc in bridge_chats:
            if bc.get("phone") in imported_phones:
                continue
            available.append({
                "phone": bc.get("phone"),
                "name": bc.get("name"),
                "isGroup": bc.get("isGroup", False),
                "lastMessage": bc.get("lastMessage"),
                "imported": False,
            })

    return {"imported": imported, "available": available}


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