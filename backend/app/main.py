from dotenv import load_dotenv

load_dotenv()  # must run before app imports — security.py reads JWT_SECRET/ENVIRONMENT from os.environ at import time

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api import agent, analytics, auth, chat, contacts, search, status, style, upload, whatsapp, workspaces
from app.core.security import hash_password
from app.kb.database import SessionLocal, engine
from app.kb.models import Base, Tenant, User, Workspace


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure all tables exist (safe no-op if already created)
    Base.metadata.create_all(bind=engine)

    # Idempotent migrations — add new columns to existing tables
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS bridge_port INTEGER DEFAULT 3001"))
        conn.execute(text("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS phone_label VARCHAR(50)"))
        conn.execute(text("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()"))
        conn.execute(text("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT"))
        conn.execute(text("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags TEXT[]"))
        conn.execute(text("ALTER TABLE chats ADD COLUMN IF NOT EXISTS phone VARCHAR(50)"))
        conn.execute(text("ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE"))
        conn.execute(text("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone VARCHAR(50)"))
        conn.execute(text("ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_message_id VARCHAR(100)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_wa_message_id ON messages (wa_message_id)"))
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE"))
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE"))
        conn.execute(text("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE"))
        conn.commit()

    db = SessionLocal()
    try:
        # Ensure default tenant exists
        tenant = db.query(Tenant).first()
        if not tenant:
            tenant = Tenant(name="Default")
            db.add(tenant)
            db.commit()
            db.refresh(tenant)

        # Migrate existing users and workspaces to the default tenant
        db.execute(text(f"UPDATE users SET tenant_id = {tenant.id} WHERE tenant_id IS NULL AND role != 'superadmin'"))
        db.execute(text(f"UPDATE workspaces SET tenant_id = {tenant.id} WHERE tenant_id IS NULL"))
        db.commit()

        if not db.query(Workspace).first():
            db.add(Workspace(name="Main Number", bridge_port=3001, tenant_id=1))
            db.commit()

        if not db.query(User).filter(User.role == "superadmin").first():
            db.add(User(
                username="platform",
                hashed_password=hash_password("platform2026"),
                role="superadmin",
                tenant_id=None,
            ))
            db.commit()
            print("[auth] Superadmin created: platform / platform2026 — change this password!")

        if not db.query(User).filter(User.role == "owner").first():
            db.add(User(
                username="admin",
                hashed_password=hash_password("twin2026"),
                role="owner",
                tenant_id=1,
            ))
            db.commit()
            print("[auth] Default owner created: admin / twin2026 — change this password!")
    finally:
        db.close()

    # Tier 2 — background burst summarizer: distills quiet live conversations
    # into summarized, embedded threads (long-term memory)
    async def _burst_loop():
        from app.kb.burst_summarizer import run_burst_summarizer
        while True:
            await asyncio.sleep(300)  # every 5 minutes
            try:
                n = await asyncio.to_thread(run_burst_summarizer)
                if n:
                    print(f"[memory] burst summarizer created {n} thread(s)")
            except Exception as e:
                print(f"[memory] burst summarizer error: {e}")

    from app.config import settings as _settings
    burst_task = asyncio.create_task(_burst_loop()) if _settings.gemini_api_key else None

    yield

    if burst_task:
        burst_task.cancel()


app = FastAPI(title="Twin", version="0.5.0", lifespan=lifespan)

_allowed_origin = os.environ.get("ALLOWED_ORIGIN", "http://localhost:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[_allowed_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*", "X-Workspace-ID"],
)

app.include_router(auth.router,       prefix="/api", tags=["auth"])
app.include_router(agent.router,      prefix="/api", tags=["agent"])
app.include_router(upload.router,     prefix="/api", tags=["upload"])
app.include_router(status.router,     prefix="/api", tags=["status"])
app.include_router(search.router,     prefix="/api", tags=["search"])
app.include_router(chat.router,       prefix="/api", tags=["chat"])
app.include_router(workspaces.router, prefix="/api", tags=["workspaces"])
app.include_router(contacts.router,   prefix="/api", tags=["contacts"])
app.include_router(analytics.router,  prefix="/api", tags=["analytics"])
app.include_router(whatsapp.router,   prefix="/api", tags=["whatsapp"])
app.include_router(style.router,      prefix="/api", tags=["style"])


@app.get("/health")
def health():
    return {"status": "ok"}