# Twin — AI WhatsApp Business Twin

**Twin** is a self-hosted AI system that learns how a business owner communicates on WhatsApp and acts as their digital twin. It reads incoming customer messages, generates draft replies written in the owner's exact style and voice, and waits for human approval before sending anything. The owner always has full control — the AI never sends without explicit confirmation.

The system also serves as an intelligent business co-pilot: query your entire conversation history in natural language, get analytics, and instruct the AI to compose and send messages to any contact.

---

## Features

- **Draft replies** — AI reads each incoming customer message and writes a draft in the owner's voice
- **Style learning** — Scans past "Me" messages, builds a detailed style profile (tone, vocabulary, formality, language patterns)
- **Owner co-pilot** — Natural-language chat interface: query past conversations, get analytics, send messages by name
- **Knowledge base** — All WhatsApp history indexed with vector + full-text hybrid search (Gemini embeddings)
- **Approve / reject drafts** — Drafts appear in the thread; owner approves or discards before anything sends
- **Multi-number support** — Each workspace maps to a separate bridge on its own port
- **Role-based access** — Owner / Assistant / Viewer with JWT auth and httpOnly cookies
- **Demo mode** — Load 85 realistic sample contacts (no WhatsApp needed) to explore all features
- **Dark premium UI** — Clean dark interface with green accent, Inter font, responsive three-pane inbox

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | FastAPI (Python 3.11+) · port 8000 |
| **Frontend** | Next.js 14 App Router · port 3000 |
| **Bridge** | Node.js + whatsapp-web.js · port 3001 |
| **Database** | PostgreSQL 14+ |
| **AI / Embeddings** | Google Gemini (`gemini-2.5-flash-lite`, `text-embedding-001`) |
| **Auth** | python-jose + passlib bcrypt, httpOnly JWT cookie |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│              Next.js Frontend  (port 3000)              │
└──────────────────────┬──────────────────────────────────┘
                       │  HTTP + SSE (Next.js rewrites /api/*)
                       ▼
┌─────────────────────────────────────────────────────────┐
│              FastAPI Backend  (port 8000)                │
│  Auth · Agent · KB · Analytics · Workspaces · Style     │
└────────────┬────────────────────────┬───────────────────┘
             │  HTTP (X-Bridge-Secret) │  SQLAlchemy
             ▼                         ▼
┌──────────────────────┐  ┌───────────────────────────────┐
│  Bridge  (port 3001) │  │        PostgreSQL              │
│  whatsapp-web.js     │  │  contacts · messages          │
│  QR → WhatsApp Web   │  │  embeddings (REAL[]) · users  │
│  inbound webhooks    │  │  workspaces · audit_log       │
└──────────────────────┘  └───────────────────────────────┘
```

**Request flow for a new customer message:**
1. Customer texts the business WhatsApp number
2. Bridge receives the message via whatsapp-web.js, posts it to `/api/whatsapp/inbound`
3. Backend fetches the contact's history + owner style profile, calls Gemini to generate a draft
4. Draft appears in the owner's inbox (frontend polls `/api/whatsapp/conversations`)
5. Owner reviews the thread, clicks **Approve & Send** (or edits then approves)
6. Backend calls bridge → bridge sends via whatsapp-web.js

---

## File Structure

```
twin/
├── backend/
│   ├── app/
│   │   ├── main.py                   FastAPI entry point, CORS config, lifespan startup
│   │   ├── core/
│   │   │   ├── security.py           JWT encode/decode, bcrypt hashing, cookie helpers,
│   │   │   │                         bridge secret validation
│   │   │   └── database.py           SQLAlchemy engine + session factory
│   │   ├── kb/
│   │   │   ├── models.py             ORM: User, Workspace, Contact, Message, Embedding…
│   │   │   ├── database.py           Table creation on startup
│   │   │   └── embeddings.py         Gemini text-embedding-001 batched calls
│   │   └── api/
│   │       ├── auth.py               POST /api/auth/login, /logout, GET /api/auth/me
│   │       │                         User CRUD (list, create, toggle-active, change-role, delete)
│   │       ├── agent.py              GET /api/agent/owner — SSE streaming co-pilot
│   │       │                         Resolves queries: analytics, send-message, KB search
│   │       ├── analytics.py          GET /api/analytics/overview, /activity, /top-contacts,
│   │       │                         /intents  (dashboard metrics)
│   │       ├── chat.py               POST /api/chat — semantic KB chat with citations (SSE)
│   │       ├── contacts.py           GET /api/contacts, /api/contacts/{id}
│   │       ├── search.py             POST /api/search — hybrid vector + FTS search
│   │       ├── status.py             GET /api/status — system health (bridge, DB, AI)
│   │       ├── style.py              GET/POST /api/style/profile, /api/style/learn,
│   │       │                         /api/style/signature  (style profile management)
│   │       ├── upload.py             POST /api/upload/parse — parse + embed chat export
│   │       ├── whatsapp.py           POST /api/whatsapp/inbound (bridge webhook)
│   │       │                         GET  /api/whatsapp/conversations
│   │       │                         POST /api/whatsapp/approve, /reject
│   │       │                         GET  /api/whatsapp/qr, /status
│   │       └── workspaces.py         Workspace CRUD + bridge relay endpoints
│   ├── .env.example                  All required environment variables (see below)
│   └── requirements.txt
│
├── bridge/
│   ├── index.js                      Express server + whatsapp-web.js client
│   │                                 Handles QR, message inbound/outbound, demo mode
│   ├── demo-data.js                  85 realistic sample contacts for demo sync
│   ├── .env.example
│   └── package.json
│
├── frontend/
│   ├── app/
│   │   ├── layout.tsx                Root layout — Google Fonts (Inter + Fira Code)
│   │   ├── globals.css               Dark theme tokens, keyframe animations:
│   │   │                             ai-pulse, ai-glow, kb-spin, kb-fade-up, kb-pulse
│   │   ├── page.tsx                  Redirect → /agent
│   │   ├── login/page.tsx            Auth form — dark card, green accent, JWT cookie
│   │   ├── agent/page.tsx            ★ Main inbox — three-pane layout:
│   │   │                               Left: conversation list + search + filters
│   │   │                               Center: message thread + approve/reject drafts
│   │   │                               Right: AI co-pilot with streaming SSE responses
│   │   │                             Also: QR modal, settings panel, sync modal, twin toggle
│   │   ├── dashboard/page.tsx        Business metrics — stat cards, activity chart,
│   │   │                             top contacts, category breakdown
│   │   ├── contacts/page.tsx         Contact grid with search
│   │   ├── contacts/[id]/page.tsx    Contact profile — appearances, recent messages,
│   │   │                             "Ask about this contact" deep-link
│   │   ├── chat/page.tsx             Full KB semantic chat — streaming responses, citations
│   │   │                             Category filter (All / Customer / Team / Supplier)
│   │   └── users/page.tsx            User + workspace management (owner only)
│   │                                 Invite users, assign roles, add/remove workspaces
│   ├── components/
│   │   ├── Sidebar.tsx               220px left sidebar — logo, workspace switcher,
│   │   │                             nav links, role badge, sign-out
│   │   └── Nav.tsx                   Legacy top navbar (replaced by Sidebar, kept for ref)
│   ├── lib/
│   │   └── auth.ts                   apiFetch (credentials + X-Workspace-ID header),
│   │                                 login(), logout(), getUser(), workspace helpers
│   ├── middleware.ts                  Route protection — checks twin_token cookie,
│   │                                 excludes /api/* from matcher
│   └── next.config.js                Rewrites /api/* → http://localhost:8000
│
├── exporter/                         WhatsApp chat export utilities (optional helper scripts)
├── samples/                          Sample .txt chat exports for local testing
├── schema.sql                        Full PostgreSQL schema (reference — tables auto-created by ORM)
└── TWIN_PROJECT.txt                  Full feature spec, architecture notes, future roadmap
```

---

## Quick Start

### Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org/)
- **Python 3.11+** — [python.org](https://python.org/)
- **PostgreSQL 14+** — [postgresql.org](https://www.postgresql.org/)
- **Google Gemini API key** — [aistudio.google.com](https://aistudio.google.com/)
- A WhatsApp account *(or use Demo mode — no WhatsApp required)*

---

### 1 — Database

```bash
psql -U postgres -c "CREATE DATABASE twin;"
```

All tables are created automatically by the backend on first start.

---

### 2 — Backend

```bash
cd backend

# Create virtualenv
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt

cp .env.example .env
# Edit .env — fill in GEMINI_API_KEY and DATABASE_URL at minimum

uvicorn app.main:app --reload --port 8000
```

On first start, the backend creates:
- The default workspace ("Main Number", bridge port 3001)
- The default admin account: **`admin` / `twin2026`** — change this immediately in `/users`

---

### 3 — Bridge

```bash
cd bridge

npm install

cp .env.example .env
# Set BRIDGE_SECRET to match backend .env

node index.js
```

Scan the QR code shown in the terminal with WhatsApp mobile (Linked Devices). The bridge connects once and stays alive.

**Multiple numbers:** run additional bridges on different ports:

```bash
BRIDGE_PORT=3002 node index.js
```

Then add the workspace in the frontend `/users` page with port `3002`.

---

### 4 — Frontend

```bash
cd frontend
npm install
npm run dev       # dev server on http://localhost:3000
```

Sign in at `http://localhost:3000/login` with the admin credentials.

---

### Terminal cheat sheet

| Terminal | Directory | Command |
|----------|-----------|---------|
| 1 | `backend/` | `uvicorn app.main:app --reload --port 8000` |
| 2 | `bridge/` | `node index.js` |
| 3 | `frontend/` | `npm run dev` |

---

## Environment Variables

### `backend/.env`

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | e.g. `postgresql://postgres:postgres@localhost:5432/twin` |
| `GEMINI_API_KEY` | ✅ | Google AI Studio API key |
| `JWT_SECRET` | ✅ prod | 64-char random hex — signs all auth tokens |
| `BRIDGE_SECRET` | ✅ prod | Shared secret between bridge and backend |
| `ALLOWED_ORIGIN` | ✅ prod | Frontend URL e.g. `https://yourdomain.com` |
| `ENVIRONMENT` | — | Set to `production` to enable strict checks |

Generate strong secrets:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### `bridge/.env`

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKEND_URL` | — | Default: `http://localhost:8000` |
| `BRIDGE_PORT` | — | Default: `3001` |
| `BRIDGE_SECRET` | ✅ prod | Must match `backend/.env` |

---

## How It Works

### Draft Generation Pipeline

```
Customer message arrives
        │
        ▼
Bridge → POST /api/whatsapp/inbound
        │
        ▼
Backend loads:
  · Contact's last N messages (conversation context)
  · Owner's global style profile
  · Per-contact learned style (if any)
        │
        ▼
Gemini generates draft reply in owner's voice
        │
        ▼
Draft stored → frontend inbox shows it
        │
        ▼
Owner: [Edit] → [Approve & Send]  OR  [Reject]
        │
        ▼
Backend → Bridge → WhatsApp → Customer
```

### Style Learning

The owner clicks **Learn my style** in the Settings panel:
1. Backend retrieves up to 500 "Me" messages from the knowledge base
2. Sends them to Gemini with a structured analysis prompt
3. Gemini returns a JSON profile: tone, formality, vocabulary, sentence patterns, Arabic/French mix ratios
4. Profile stored per-workspace, injected into every draft prompt going forward
5. Owner can also set a fixed **signature** appended to every outbound message

### Owner Co-pilot (AI Chat)

The right pane of the Inbox is a direct chat with your AI twin:

| You say | What happens |
|---------|-------------|
| `"What did Ahmed say about the order?"` | Hybrid search → KB → cited answer |
| `"Give me an overview"` | Analytics query → stat cards rendered inline |
| `"Tell Nadia her package shipped"` | Name resolution → phone lookup → draft composed → SEND PREVIEW shown |
| `"Learn my style"` | Triggers style profile rebuild |

All responses stream token-by-token via Server-Sent Events.

### Hybrid Search

Every KB query combines:
- **Vector search** — cosine similarity on Gemini `text-embedding-001` embeddings (stored as `REAL[]` in Postgres)
- **Full-text search** — PostgreSQL `tsvector` with Arabic/French/English support
- Results are merged and re-ranked for best relevance

---

## Roles & Permissions

| Role | What they can do |
|------|-----------------|
| **Owner** | Everything: inbox, approve drafts, AI co-pilot, settings, add users, manage workspaces |
| **Assistant** | Inbox, view threads, approve/reject drafts |
| **Viewer** | Read-only: inbox, dashboard, contacts (no approve, no AI co-pilot) |

Auth: httpOnly JWT cookie (`twin_token`) — never accessible to JavaScript. All sensitive routes require the cookie plus role check.

---

## Demo Mode

No WhatsApp? No problem. Click **Demo** in the inbox top bar:

1. Syncs 85 realistic Moroccan business contacts through the full embedding pipeline (~50s)
2. 5 live contacts appear with varying inbox states:
   - **Ahmed Benali** — bulk order inquiry, needs reply
   - **Fatima Zahra** — damaged delivery complaint, draft ready
   - **Youssef Kadiri** — closed fabric supply deal, replied
   - **Nadia Berrada** — active custom caftan discussion
   - **Mohammed El Alami** — asking for shop address
3. The KB is fully populated — all co-pilot queries return real answers
4. Sends in demo mode are simulated (logged but not sent via WhatsApp)

---

## Production Deployment

```bash
# Backend — strict mode requires ENVIRONMENT=production
ENVIRONMENT=production uvicorn app.main:app --port 8000 --workers 2

# Frontend — static build
cd frontend && npm run build && npm start

# Bridge
ENVIRONMENT=production BRIDGE_SECRET=your-prod-secret node bridge/index.js
```

Recommended: Nginx reverse proxy in front of both services, HTTPS via Let's Encrypt, PostgreSQL with daily backups.

---

## Version

**v0.5.0** — July 2026

### Included
- WhatsApp bridge (QR auth, inbound/outbound, multi-number)
- AI draft generation with style learning + signature
- Knowledge base (hybrid vector + FTS search, Gemini embeddings)
- Owner co-pilot with analytics, contact resolution, send-message capability
- Multi-workspace support
- JWT auth with 3 roles, httpOnly cookies, audit log
- Demo mode (85 contacts, full KB, simulated sends)
- Dark premium UI (Next.js 14, Inter font, green accent)

### Planned
- Continuous style refinement on every approved reply
- Conversation tags and notes per contact
- Bulk outbound campaigns
- Proactive AI alerts (follow-up detection, key-contact silence)
- Mobile-optimised layout
- Docker Compose for one-command deployment
