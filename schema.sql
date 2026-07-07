-- WhatsApp KB schema
-- Run against the whatsapp_kb database:
--   psql -U postgres -d whatsapp_kb -f schema.sql

-- Embeddings are stored as REAL[] (PostgreSQL native arrays).
-- Cosine similarity is computed in Python. No pgvector required.
-- To upgrade to pgvector later: replace REAL[] with vector(1536)
-- and add CREATE EXTENSION vector; at the top.

CREATE TABLE IF NOT EXISTS chats (
    id               SERIAL PRIMARY KEY,
    filename         VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255),
    upload_time      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status           VARCHAR(50)  NOT NULL DEFAULT 'pending',
    error_message    TEXT,
    participant_names TEXT[],
    message_count    INTEGER      NOT NULL DEFAULT 0,
    date_from        TIMESTAMPTZ,
    date_to          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS threads (
    id            SERIAL PRIMARY KEY,
    chat_id       INTEGER      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    thread_index  INTEGER,
    start_time    TIMESTAMPTZ,
    end_time      TIMESTAMPTZ,
    message_count INTEGER      NOT NULL DEFAULT 0,
    summary       TEXT,
    intent_tags   TEXT[],
    key_entities  JSONB,
    embedding     REAL[]
);

CREATE TABLE IF NOT EXISTS messages (
    id                 SERIAL PRIMARY KEY,
    chat_id            INTEGER     NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    thread_id          INTEGER     REFERENCES threads(id) ON DELETE SET NULL,
    burst_id           INTEGER,
    position_in_chat   INTEGER,
    timestamp          TIMESTAMPTZ,
    sender             VARCHAR(255),
    body               TEXT,
    message_type       VARCHAR(50) NOT NULL DEFAULT 'text',
    media_filename     VARCHAR(255),
    media_path         VARCHAR(500),
    transcription      TEXT,
    vision_description TEXT,
    language           VARCHAR(10),
    embedding          REAL[]
);

CREATE TABLE IF NOT EXISTS entities (
    id          SERIAL PRIMARY KEY,
    chat_id     INTEGER      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    entity_type VARCHAR(50),
    UNIQUE (chat_id, name, entity_type)
);

CREATE TABLE IF NOT EXISTS message_entities (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, entity_id)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_messages_chat_id    ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_id  ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender     ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp  ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_type       ON messages(message_type);
CREATE INDEX IF NOT EXISTS idx_threads_chat_id     ON threads(chat_id);
CREATE INDEX IF NOT EXISTS idx_entities_chat_id    ON entities(chat_id);
CREATE INDEX IF NOT EXISTS idx_entities_name       ON entities(name);

-- Full-text search index on message body (supports Arabic via 'simple' config)
CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages
    USING GIN (to_tsvector('simple', COALESCE(body, '')));

-- ─── M2: Workspace & multi-chat foundation ───────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL DEFAULT 'My Workspace',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Add workspace + category to chats (safe to run on existing DB)
ALTER TABLE chats ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS category VARCHAR(50) NOT NULL DEFAULT 'other';

-- ─── M4: Contact profiles ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contacts (
    id            SERIAL PRIMARY KEY,
    workspace_id  INTEGER      NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    display_name  VARCHAR(255) NOT NULL,
    message_count INTEGER      NOT NULL DEFAULT 0,
    chat_count    INTEGER      NOT NULL DEFAULT 0,
    last_seen     TIMESTAMPTZ,
    UNIQUE (workspace_id, display_name)
);

CREATE TABLE IF NOT EXISTS contact_appearances (
    contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    chat_id       INTEGER NOT NULL REFERENCES chats(id)    ON DELETE CASCADE,
    sender_name   VARCHAR(255),
    message_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (contact_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_chats_workspace_id              ON chats(workspace_id);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_id           ON contacts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_contact_appearances_contact_id  ON contact_appearances(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_appearances_chat_id     ON contact_appearances(chat_id);

-- After running this file on an existing database that already has chats,
-- run the following to attach them to the default workspace (id=1):
--   UPDATE chats SET workspace_id = 1 WHERE workspace_id IS NULL;
