const { Client, LocalAuth } = require('whatsapp-web.js');
const { execSync }          = require('child_process');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode         = require('qrcode');
const express        = require('express');
const cors           = require('cors');
const fetch          = require('node-fetch');
const FormData       = require('form-data');
const fs             = require('fs');
const path           = require('path');

const BACKEND_URL    = process.env.BACKEND_URL    || 'http://localhost:8000';
const PORT           = process.env.BRIDGE_PORT    || 3001;
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET  || 'twin-bridge-default-change-me';

// The backend hands us our workspace id at spawn time — the stable identity.
// Sessions are keyed by it (session-ws-{id}), NOT by port: ports are transport
// details that can be reshuffled, a workspace id never changes owner.
const WORKSPACE_ID = process.env.WORKSPACE_ID ? Number(process.env.WORKSPACE_ID) : null;
const CLIENT_ID    = WORKSPACE_ID != null ? `ws-${WORKSPACE_ID}` : `port-${PORT}`; // legacy fallback for manual runs
const DAILY_LIMIT  = 40;
const WARN_AT      = 30;
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 10000;

// Shared storage — backend serves media from the same folder via /api/media
const MEDIA_DIR = path.join(__dirname, '..', 'storage', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

// Downloads a message's media (if any) and saves it to shared storage.
// Returns the saved filename, or null if there's no media / download fails.
// Safe to call repeatedly — skips re-writing if the file already exists.
async function downloadMedia(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;
    const mime = (media.mimetype || '').split(';')[0].trim();
    const ext  = MIME_EXT[media.mimetype] || MIME_EXT[mime] || (mime.split('/')[1] || 'bin');
    const filename = `${msg.id.id}.${ext}`;
    const filePath = path.join(MEDIA_DIR, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
    }
    return filename;
  } catch (e) {
    console.error(`[bridge] media download failed for msg ${msg.id && msg.id.id}:`, e.message);
    return null;
  }
}

// ── State ──────────────────────────────────────────────────────────────────────

let qrDataUrl    = null;
let isConnected  = false;
let phoneInfo    = null;
let initStarted  = false; // true once client.initialize() has been called
let initError    = null;  // last initialization failure, surfaced to the UI
let dailySent    = 0;
let lastSendAt   = 0;
let resetDate    = new Date().toDateString();
let demoMode     = false;  // when true, sendMessage is a no-op (demo presentation)

const seenSenders   = new Set();   // phones that have messaged us first
const conversations = new Map();   // phone → ConversationState

// sync job state
const syncState = {
  running:  false,
  total:    0,
  done:     0,
  failed:   0,
  skipped:  0,
  current:  null,
  log:      [],   // last 50 lines
  finishedAt: null,
};

function syncLog(line) {
  console.log('[sync]', line);
  syncState.log.push(line);
  if (syncState.log.length > 50) syncState.log.shift();
}

function mkConv(phone, name, serializedId = null) {
  return { id: phone, name, chatId: serializedId || `${phone}@c.us`, messages: [], draftReply: null, status: 'active', twinEnabled: true, updatedAt: new Date().toISOString() };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function resetDaily() {
  const today = new Date().toDateString();
  if (today !== resetDate) { dailySent = 0; resetDate = today; }
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _bridgeHeaders = { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET };

async function notifyBackend(path, data) {
  try {
    await fetch(`${BACKEND_URL}/api/whatsapp/${path}`, {
      method:  'POST',
      headers: _bridgeHeaders,
      body:    JSON.stringify(data),
      timeout: 8000,
    });
  } catch (e) {
    console.error(`[bridge] backend notify failed (${path}):`, e.message);
  }
}

// ── Chat history → .txt formatter ────────────────────────────────────────────

function formatTimestamp(unixTs) {
  const d = new Date(unixTs * 1000);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}, ${hh}:${mi}`;
}

function formatChatAsTxt(chatName, messages) {
  const lines = [];
  for (const msg of messages) {
    if (!msg.timestamp) continue;
    const ts     = formatTimestamp(msg.timestamp);
    const sender = msg.fromMe
      ? 'Me'
      : (msg.author ? msg.author.replace(/@.*$/, '') : chatName);
    if (['ptt', 'audio'].includes(msg.type))              lines.push(`${ts} - ${sender}: <Voice note omitted>`);
    else if (['image','video'].includes(msg.type))        lines.push(`${ts} - ${sender}: <Media omitted>`);
    else if (msg.type === 'sticker')                      lines.push(`${ts} - ${sender}: sticker omitted`);
    else if (msg.type === 'document')                     lines.push(`${ts} - ${sender}: document omitted`);
    else if (msg.type === 'location')                     lines.push(`${ts} - ${sender}: <Location omitted>`);
    else if (['vcard','multi_vcard'].includes(msg.type))  lines.push(`${ts} - ${sender}: Contact card omitted`);
    else if (msg.body && msg.body.trim())                 lines.push(`${ts} - ${sender}: ${msg.body.trim()}`);
  }
  return lines.join('\n');
}

// ── Demo sync — runs fake contacts through the real upload pipeline ────────────

async function runDemoSync() {
  const { ALL_CONTACTS, ACTIVE } = require('./demo-data');

  if (syncState.running) return;

  // Clear existing inbox so re-running demo always starts fresh
  conversations.clear();
  demoMode = false;

  Object.assign(syncState, {
    running: true, total: ALL_CONTACTS.length, done: 0,
    failed: 0, skipped: 0, current: null, log: [], finishedAt: null,
  });

  let workspaceId = await getWorkspaceId();

  syncLog(`Demo mode — importing ${ALL_CONTACTS.length} contacts…`);

  for (const contact of ALL_CONTACTS) {
    syncState.current = contact.name;

    if (!contact.msgs || contact.msgs.length === 0) {
      syncLog(`${contact.name} — empty, skipped`);
      syncState.skipped++;
      syncState.done++;
      await sleep(150);
      continue;
    }

    try {
      const content  = formatChatAsTxt(contact.name, contact.msgs);
      const safeName = contact.name.replace(/[<>:"/\\|?*]/g, '_');

      const form = new FormData();
      form.append('file', Buffer.from(content, 'utf-8'), { filename: `${safeName}.txt`, contentType: 'text/plain' });
      form.append('category',     contact.category || 'customer');
      form.append('workspace_id', String(workspaceId));

      const res = await fetch(`${BACKEND_URL}/api/upload/parse`, { method: 'POST', body: form, headers: { ...form.getHeaders(), 'X-Bridge-Secret': BRIDGE_SECRET } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      syncLog(`${contact.name} — ✓ ${contact.msgs.length} msgs`);
      syncState.done++;
    } catch (e) {
      syncLog(`${contact.name} — ✗ ${e.message}`);
      syncState.failed++;
      syncState.done++;
    }

    // Realistic pacing: 350-600ms per contact → ~50 contacts in ~25 seconds
    await sleep(350 + Math.floor(Math.random() * 250));
  }

  // Populate inbox with the 5 active demo contacts
  for (const contact of ACTIVE) {
    const conv    = mkConv(contact.phone, contact.name, `${contact.phone}@c.us`);
    conv.status   = contact.inboxStatus || 'active';
    conv.messages = contact.msgs.slice(-10).map(m => ({
      role:      m.fromMe ? 'agent' : 'customer',
      content:   m.body,
      timestamp: new Date(m.timestamp * 1000).toISOString(),
    }));
    if (contact.draftReply) conv.draftReply = contact.draftReply;
    conv.updatedAt = new Date(contact.msgs[contact.msgs.length - 1].timestamp * 1000).toISOString();
    conversations.set(contact.phone, conv);
  }

  demoMode              = true;
  syncState.running     = false;
  syncState.current     = null;
  syncState.finishedAt  = new Date().toISOString();
  syncLog(`Done — ${ALL_CONTACTS.length} contacts imported · inbox ready with ${ACTIVE.length} active conversations`);

  // Ask the backend to generate real AI drafts for any active contact that
  // needs a reply and doesn't already have a scripted draftReply above.
  // This mirrors the real client.on('message', ...) inbound flow so demo
  // mode exercises the actual Gemini draft pipeline instead of static text.
  for (const contact of ACTIVE) {
    const conv = conversations.get(contact.phone);
    if (!conv || conv.status !== 'needs_reply' || conv.draftReply) continue;

    const lastCustomerMsg = [...conv.messages].reverse().find(m => m.role === 'customer');
    if (!lastCustomerMsg) continue;

    syncLog(`${contact.name} — requesting AI draft…`);
    notifyBackend('inbound', {
      phone:       contact.phone,
      name:        contact.name,
      body:        lastCustomerMsg.content,
      timestamp:   Math.floor(new Date(lastCustomerMsg.timestamp).getTime() / 1000),
      history:     conv.messages.slice(-20),
      bridge_port: Number(PORT),
    });
  }
}

// Convert a whatsapp-web.js Message into a plain structured entry for the
// backend's JSON import endpoint. Non-text messages get a short, plain
// placeholder (e.g. "audio", "image", "sticker") instead of a formatted
// string, plus the actual downloaded media file when available.
async function toStructuredEntry(msg, chatName) {
  if (!msg.timestamp) return null;
  const sender = msg.fromMe
    ? 'Me'
    : (msg.author ? msg.author.replace(/@.*$/, '') : chatName);

  let body = null;
  let type = 'text';

  if (['ptt', 'audio'].includes(msg.type))            { body = 'audio';   type = 'voice'; }
  else if (msg.type === 'image')                      { body = 'image';   type = 'image'; }
  else if (msg.type === 'video')                       { body = 'video';   type = 'video'; }
  else if (msg.type === 'sticker')                     { body = 'sticker'; type = 'sticker'; }
  else if (msg.type === 'document')                    { body = 'document';type = 'document'; }
  else if (msg.type === 'location')                    { body = 'location';type = 'media'; }
  else if (['vcard','multi_vcard'].includes(msg.type)) { body = 'contact'; type = 'media'; }
  else if (msg.body && msg.body.trim())                { body = msg.body.trim(); type = 'text'; }

  if (body === null) return null; // unrecognized/system-only message — skip

  let mediaFilename = null;
  if (msg.hasMedia && type !== 'text') {
    mediaFilename = await downloadMedia(msg);
  }

  return {
    timestamp: msg.timestamp, sender, body, message_type: type,
    media_filename: mediaFilename,
    wa_message_id: (msg.id && msg.id.id) || null,
  };
}

// ── Live persistence (Tier 1) — every message goes to the KB immediately ──────

function entryToWire(entry) {
  return {
    direction:      entry.sender === 'Me' ? 'out' : 'in',
    body:           entry.body,
    message_type:   entry.message_type,
    timestamp:      entry.timestamp,
    media_filename: entry.media_filename || null,
    wa_message_id:  entry.wa_message_id || null,
  };
}

// Fire-and-forget — persistence must never block or crash message handling.
async function persistMessages(phone, name, entries) {
  if (!entries || entries.length === 0) return;
  try {
    await fetch(`${BACKEND_URL}/api/whatsapp/messages`, {
      method:  'POST',
      headers: _bridgeHeaders,
      body:    JSON.stringify({ phone, name, bridge_port: Number(PORT), messages: entries.map(entryToWire) }),
    });
  } catch (e) {
    console.error(`[bridge] persist failed for ${phone}:`, e.message);
  }
}

// ── Sync job — uploads chat history to the KB ──────────────────────────────

async function getWorkspaceId() {
  if (WORKSPACE_ID != null) return WORKSPACE_ID; // handed to us at spawn — no guessing
  try {
    const r = await fetch(`${BACKEND_URL}/api/workspace/by-port/${PORT}`, {
      headers: { 'X-Bridge-Secret': BRIDGE_SECRET },
    });
    const d = await r.json();
    if (typeof d.id !== 'number') throw new Error(`unexpected response: ${JSON.stringify(d)}`);
    return d.id;
  } catch (e) {
    console.error('[bridge] could not resolve workspace id, defaulting to 1:', e.message);
    return 1;
  }
}

// Rebuilds the in-memory inbox from already-imported chats in the KB — run
// once at startup so restarting the bridge doesn't wipe the visible Inbox
// (conversations only ever lived in memory before this).
async function rehydrateInbox(workspaceId) {
  try {
    const r = await fetch(`${BACKEND_URL}/api/whatsapp/inbox/rehydrate?workspace_id=${workspaceId}`, {
      headers: { 'X-Bridge-Secret': BRIDGE_SECRET },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const chats = await r.json();

    for (const c of chats) {
      const conv = mkConv(c.phone, c.name, `${c.phone}@c.us`);
      conv.messages = c.messages.map(m => ({
        role:      m.sender === 'Me' ? 'agent' : 'customer',
        content:   m.body,
        timestamp: m.timestamp,
      }));
      conv.status = 'active';
      if (conv.messages.length) {
        conv.updatedAt = conv.messages[conv.messages.length - 1].timestamp;
      }
      conversations.set(c.phone, conv);
    }

    console.log(`[bridge] rehydrated inbox — ${chats.length} chat(s) restored from KB`);
  } catch (e) {
    console.error('[bridge] inbox rehydration failed:', e.message);
  }
}

// Imports a single chat's history (used by both bulk sync and the
// "Add to chat" single-contact import). Registers it in the live inbox
// and uploads it to the KB. Returns a result summary, never throws.
async function importOneChat(chat, category, workspaceId) {
  const name  = chat.name || chat.id.user;
  const phone = chat.id.user;

  if (!conversations.has(phone)) {
    conversations.set(phone, mkConv(phone, name, chat.id._serialized));
  } else {
    const conv = conversations.get(phone);
    conv.name   = name;
    conv.chatId = chat.id._serialized;
  }

  try {
    const rawMessages = await chat.fetchMessages({ limit: 50 });

    if (rawMessages.length === 0) {
      return { status: 'empty', name, phone };
    }

    const structured = [];
    for (const m of rawMessages) {
      const entry = await toStructuredEntry(m, name);
      if (entry) structured.push(entry);
    }

    if (structured.length === 0) {
      return { status: 'empty', name, phone };
    }

    const res = await fetch(`${BACKEND_URL}/api/upload/import-messages`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
      body:    JSON.stringify({ chat_name: name, phone, is_group: !!chat.isGroup, category, workspace_id: workspaceId, messages: structured }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    // Populate the in-memory inbox thread too — upload-messages only feeds
    // the knowledge base, it doesn't touch conversations, so without this
    // the contact shows up in the inbox with an empty thread.
    const conv = conversations.get(phone);
    if (conv) {
      conv.messages = structured.slice(-30).map(m => ({
        role:      m.sender === 'Me' ? 'agent' : 'customer',
        content:   m.body,
        timestamp: new Date(m.timestamp * 1000).toISOString(),
        mediaType: m.message_type !== 'text' ? m.message_type : null,
        mediaUrl:  m.media_filename ? `/api/media/${m.media_filename}` : null,
      }));
      conv.updatedAt = conv.messages.length
        ? conv.messages[conv.messages.length - 1].timestamp
        : conv.updatedAt;
    }

    return { status: 'ok', name, phone, messageCount: structured.length, jobId: result.job_id };
  } catch (e) {
    return { status: 'error', name, phone, error: e.message };
  }
}

async function runSync(category = 'customer', selectedPhones = null) {
  if (syncState.running) return;
  if (!isConnected)      throw new Error('Not connected to WhatsApp');

  // Clear existing inbox so re-sync always starts fresh
  conversations.clear();

  Object.assign(syncState, { running: true, total: 0, done: 0, failed: 0, skipped: 0, current: null, log: [], finishedAt: null });

  const workspaceId = await getWorkspaceId();

  let chats = await client.getChats();
  if (Array.isArray(selectedPhones) && selectedPhones.length > 0) {
    const wanted = new Set(selectedPhones);
    chats = chats.filter(c => wanted.has(c.id.user));
    syncLog(`Importing ${chats.length} selected chat(s) of ${selectedPhones.length} requested…`);
  } else {
    syncLog(`Found ${chats.length} chats — starting upload…`);
  }
  syncState.total = chats.length;

  for (const chat of chats) {
    syncState.current = chat.name || chat.id.user;
    const result = await importOneChat(chat, category, workspaceId);

    if (result.status === 'ok') {
      syncLog(`${result.name} — ✓ ${result.messageCount} msgs → job #${result.jobId}`);
      syncState.done++;
    } else if (result.status === 'empty') {
      syncLog(`${result.name} — empty, skipped`);
      syncState.skipped++;
      syncState.done++;
    } else {
      syncLog(`${result.name} — ✗ ${result.error}`);
      syncState.failed++;
      syncState.done++;
    }

    await sleep(1000); // whatsapp-web.js needs time to switch chat context between fetches
  }

  syncState.running    = false;
  syncState.current    = null;
  syncState.finishedAt = new Date().toISOString();
  syncLog(`Done — ${syncState.done - syncState.failed - syncState.skipped} uploaded, ${syncState.skipped} empty, ${syncState.failed} failed`);
}

// ── Core send — enforces all safety limits ─────────────────────────────────────

async function sendMessage(phone, message) {
  // Demo mode: simulate send without touching WhatsApp
  if (demoMode) {
    console.log(`[bridge] DEMO send → ${phone}: "${message.slice(0, 60)}"`);
    dailySent++;
    return;
  }

  resetDaily();
  if (!isConnected) throw new Error('WhatsApp not connected');
  if (dailySent >= DAILY_LIMIT) throw new Error(`Daily send limit (${DAILY_LIMIT}) reached — try again tomorrow`);
  if (dailySent >= WARN_AT) console.warn(`[bridge] Warning: ${dailySent}/${DAILY_LIMIT} messages sent today`);

  const elapsed = Date.now() - lastSendAt;
  const needed  = randomDelay();
  if (elapsed < needed) await sleep(needed - elapsed);

  // Use the stored serialized chatId if available (avoids LID lookup issues)
  const conv   = conversations.get(phone);
  const chatId = (conv && conv.chatId) ? conv.chatId : `${phone}@c.us`;
  await client.sendMessage(chatId, message);

  dailySent++;
  lastSendAt = Date.now();
  console.log(`[bridge] Sent → ${phone} (${chatId})  [${dailySent}/${DAILY_LIMIT}]  "${message.slice(0, 60)}"`);
}

// ── WhatsApp client ────────────────────────────────────────────────────────────

// One-time migration: sessions used to be keyed by port. If a ws-keyed dir
// doesn't exist yet but the old port-keyed one does, adopt it — an already
// linked number keeps working without a re-scan.
if (WORKSPACE_ID != null) {
  const oldDir = path.join(__dirname, '.wwebjs_auth', `session-port-${PORT}`);
  const newDir = path.join(__dirname, '.wwebjs_auth', `session-ws-${WORKSPACE_ID}`);
  if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
    try {
      fs.renameSync(oldDir, newDir);
      console.log(`[bridge] migrated session: session-port-${PORT} -> session-ws-${WORKSPACE_ID}`);
    } catch (e) {
      console.error('[bridge] session migration failed:', e.message);
    }
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth', clientId: CLIENT_ID }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  restartOnAuthFail: true,
  takeoverOnConflict: true,
  takeoverTimeoutMs: 10000,
});

client.on('qr', async qr => {
  qrcodeTerminal.generate(qr, { small: true });
  qrDataUrl = await QRCode.toDataURL(qr);
  initError = null;
  console.log('[bridge] QR ready — scan with WhatsApp');
});

client.on('authenticated', () => {
  qrDataUrl = null;
  initError = null;
  console.log('[bridge] Authenticated');
});

client.on('ready', async () => {
  isConnected = true;
  qrDataUrl   = null;
  const info  = client.info;
  phoneInfo   = { number: info.wid.user, name: info.pushname, platform: info.platform };
  console.log(`[bridge] Ready — ${phoneInfo.name} (${phoneInfo.number})`);
  await notifyBackend('connected', phoneInfo);
  refreshInboxThreads().catch(e => console.error('[bridge] thread refresh failed:', e.message));
});

client.on('disconnected', async reason => {
  isConnected = false;
  phoneInfo   = null;
  qrDataUrl   = null;
  initStarted = false; // allow a fresh /connect to re-initialize
  console.log('[bridge] Disconnected:', reason);
  await notifyBackend('disconnected', { reason });
  try { await client.destroy(); } catch {}
});

client.on('message', async msg => {
  if (msg.from === 'status@broadcast') return;
  if (msg.from.endsWith('@g.us')) return; // skip groups for now

  const phone = msg.from.replace(/@.*$/, '');

  // Only show messages from contacts that have already been imported
  // (bulk sync, "Add to chat", or restored on startup). A message from
  // someone never imported is ignored entirely — no inbox entry, no draft.
  if (!conversations.has(phone)) {
    console.log(`[bridge] Message from non-imported contact ${phone} — ignoring`);
    return;
  }

  const contact = await msg.getContact();
  const name    = contact.pushname || contact.name || phone;

  seenSenders.add(phone);

  const conv = conversations.get(phone);
  conv.name   = name;
  conv.chatId = msg.from; // always use the actual serialized ID from the message
  conv.messages.push({ role: 'customer', content: msg.body, timestamp: new Date(msg.timestamp * 1000).toISOString() });
  conv.draftReply = null;
  conv.status     = 'needs_reply';
  conv.updatedAt  = new Date().toISOString();

  console.log(`[bridge] Inbound from ${name} (${phone}): "${msg.body.slice(0, 60)}"`);

  // Tier 1 — persist to the KB immediately, regardless of twin on/off
  toStructuredEntry(msg, name).then(e => e && persistMessages(phone, name, [e])).catch(() => {});

  // Skip twin draft generation if twin is disabled for this contact
  if (!conv.twinEnabled) {
    console.log(`[bridge] Twin disabled for ${name} — skipping draft`);
    return;
  }

  await notifyBackend('inbound', {
    phone,
    name,
    body:        msg.body,
    timestamp:   msg.timestamp,
    history:     conv.messages.slice(-20),
    bridge_port: Number(PORT),
  });
});

// Outgoing messages typed on the phone itself — the 'message' event only fires
// for incoming, so without this the owner's own phone replies never show in
// the inbox thread. App-initiated sends are pushed by the send endpoints
// directly, hence the duplicate check.
client.on('message_create', async msg => {
  if (!msg.fromMe) return; // incoming handled by the 'message' listener
  if (!msg.to || msg.to === 'status@broadcast' || msg.to.endsWith('@g.us')) return;

  const phone = msg.to.replace(/@.*$/, '');
  const conv  = conversations.get(phone);
  if (!conv) return; // only track imported contacts

  // Tier 1 — persist every outbound exactly once here (app sends fire this
  // event too; the backend dedups by WhatsApp message id)
  toStructuredEntry(msg, conv.name).then(e => e && persistMessages(phone, conv.name, [e])).catch(() => {});

  // Skip the in-memory push if this exact text was just pushed by an app send endpoint
  const recent = conv.messages.slice(-3);
  if (recent.some(m => m.role === 'agent' && m.content === msg.body)) return;

  conv.messages.push({ role: 'agent', content: msg.body, timestamp: new Date(msg.timestamp * 1000).toISOString() });
  conv.draftReply = null;
  conv.status     = 'active';
  conv.updatedAt  = new Date().toISOString();
  console.log(`[bridge] Phone reply to ${conv.name}: "${(msg.body || '').slice(0, 60)}"`);
});

// ── Chat list cache ────────────────────────────────────────────────────────────
// getChats is expensive (sequential walk of every chat). The list is cached
// and served instantly; refreshes happen in the background.

let chatListCache      = null;   // { at: epoch-ms, list: [...] }
let chatListRefreshing = false;
const CHAT_LIST_TTL_MS = 2 * 60 * 1000;

function buildChatList(chats) {
  return chats.map(c => ({
    phone:         c.id.user,
    name:          c.name || c.id.user,
    isGroup:       !!c.isGroup,
    lastMessage:   c.lastMessage ? c.lastMessage.body : null,
    lastMessageAt: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : null,
    unreadCount:   c.unreadCount || 0,
  })).sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
}

async function refreshChatList() {
  if (chatListRefreshing || !isConnected) return;
  chatListRefreshing = true;
  try {
    chatListCache = { at: Date.now(), list: buildChatList(await client.getChats()) };
    console.log(`[bridge] chat list cached (${chatListCache.list.length} chats)`);
  } catch (e) {
    console.error('[bridge] chat list refresh failed:', e.message);
  } finally {
    chatListRefreshing = false;
  }
}

// Re-fetches the last 30 messages of every known conversation — run after
// (re)connecting so anything sent or received while the bridge was offline
// shows up instead of the thread staying frozen at the import snapshot.
async function refreshInboxThreads() {
  // Look chats up from the live list instead of getChatById — the chatId we
  // hold after a restart is a guess (`phone@c.us`) and fails for contacts on
  // WhatsApp's new @lid addressing. Matching by id.user sidesteps the suffix.
  let byUser;
  try {
    const chats = await client.getChats();
    // Same expensive fetch also warms the chat-list cache, so the import
    // modal's contact picker is instant right after connecting
    chatListCache = { at: Date.now(), list: buildChatList(chats) };
    console.log(`[bridge] chat list cached (${chatListCache.list.length} chats)`);
    byUser = new Map(chats.map(c => [c.id.user, c]));
  } catch (e) {
    console.error('[bridge] thread refresh aborted — getChats failed:', e.message);
    return;
  }

  for (const conv of conversations.values()) {
    try {
      const chat = byUser.get(conv.id);
      if (!chat) continue; // no matching live chat (e.g. cleared history)
      conv.chatId = chat.id._serialized; // heal the guessed chatId for future sends
      const raw  = await chat.fetchMessages({ limit: 30 });
      const entries = [];
      const msgs = [];
      for (const m of raw) {
        const e = await toStructuredEntry(m, conv.name);
        if (!e) continue;
        entries.push(e);
        msgs.push({
          role:      e.sender === 'Me' ? 'agent' : 'customer',
          content:   e.body,
          timestamp: new Date(e.timestamp * 1000).toISOString(),
          mediaType: e.message_type !== 'text' ? e.message_type : null,
          mediaUrl:  e.media_filename ? `/api/media/${e.media_filename}` : null,
        });
      }
      if (msgs.length) {
        conv.messages  = msgs;
        conv.updatedAt = msgs[msgs.length - 1].timestamp;
      }
      // Tier 1 — backfill anything sent/received while the bridge was offline
      // into the KB (idempotent server-side, so overlap with past syncs is fine)
      await persistMessages(conv.id, conv.name, entries);
      await sleep(300); // don't hammer WhatsApp Web between chats
    } catch (e) {
      console.error(`[bridge] thread refresh failed for ${conv.name}:`, e.message);
    }
  }
  console.log(`[bridge] inbox threads refreshed (${conversations.size} chats)`);
}

// ── Express API ────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Status — polled by frontend (via FastAPI)
app.get('/status', (req, res) => {
  resetDaily();
  res.json({
    connected:    isConnected,
    qr:           qrDataUrl,
    waiting:      !initStarted, // idle — no QR until POST /connect
    booting:      initStarted && !isConnected && !qrDataUrl, // Chrome starting up — QR not ready yet
    init_error:   initError,
    workspace_id: WORKSPACE_ID, // self-identification — backend verifies this matches
    port:         Number(PORT),
    phone:        phoneInfo,
    daily_sent:   dailySent,
    daily_limit:  DAILY_LIMIT,
    warn_at:      WARN_AT,
    seen_senders: seenSenders.size,
  });
});

// Start the WhatsApp client on demand — called when the user clicks
// "Connect WhatsApp" in the UI. Idempotent.
app.post('/connect', (req, res) => {
  if (isConnected) return res.json({ ok: true, connected: true });
  startClient();
  res.json({ ok: true, connected: false });
});

// Conversation list — polled by frontend inbox
app.get('/conversations', (req, res) => {
  const list = Array.from(conversations.values())
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(list);
});

// Single conversation — used by the backend's regenerate-draft flow
app.get('/conversations/:phone', (req, res) => {
  const conv = conversations.get(req.params.phone);
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json(conv);
});

// FastAPI sets draft reply after agent generates it
app.post('/conversations/:phone/draft', (req, res) => {
  const conv = conversations.get(req.params.phone);
  if (!conv) return res.status(404).json({ error: 'not found' });
  conv.draftReply = req.body.reply;
  // Clearing the draft (reply: null) — e.g. Discard, or before regenerating —
  // should put the conversation back in "needs_reply", not leave it stuck as
  // "draft_ready" with no draft to show.
  conv.status     = req.body.reply ? 'draft_ready' : 'needs_reply';
  conv.updatedAt  = new Date().toISOString();
  res.json({ ok: true });
});

// Owner approves draft → bridge sends it
app.post('/conversations/:phone/approve', async (req, res) => {
  const conv = conversations.get(req.params.phone);
  if (!conv || !conv.draftReply) return res.status(404).json({ error: 'no draft' });
  const sentText = conv.draftReply;
  try {
    await sendMessage(req.params.phone, sentText);
    conv.messages.push({ role: 'agent', content: sentText, timestamp: new Date().toISOString() });
    conv.draftReply = null;
    conv.status     = 'replied';
    conv.updatedAt  = new Date().toISOString();
    res.json({ ok: true, sent_text: sentText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Owner edits draft manually then approves
app.post('/conversations/:phone/send', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const conv = conversations.get(req.params.phone) || mkConv(req.params.phone, req.params.phone);
  conversations.set(req.params.phone, conv);
  try {
    await sendMessage(req.params.phone, message);
    conv.messages.push({ role: 'agent', content: message, timestamp: new Date().toISOString() });
    conv.draftReply = null;
    conv.status     = 'replied';
    conv.updatedAt  = new Date().toISOString();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve a contact name to a phone number
app.get('/contacts/resolve', async (req, res) => {
  const raw  = (req.query.name || '').trim();
  const name = raw.toLowerCase();
  if (!name) return res.status(400).json({ error: 'name required' });

  // If it already looks like a phone number, return it directly
  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly.length >= 6) return res.json({ phone: digitsOnly, name: raw });

  function normalizeName(s) {
    return s.toLowerCase()
      .replace(/[^\w\s؀-ۿ]/g, ' ')  // punctuation → space (keeps Arabic)
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Score-based matching on normalized names: exact > all words match > any word match
  function matchScore(rawCname, rawQuery) {
    const cname = normalizeName(rawCname);
    const query = normalizeName(rawQuery);
    if (cname === query) return 3;
    const qWords = query.split(' ').filter(w => w.length > 1);
    if (qWords.length > 0 && qWords.every(w => cname.includes(w))) return 2;
    if (qWords.some(w => cname.includes(w))) return 1;
    return 0;
  }

  // 1. Check in-memory conversations first
  let best = null, bestScore = 0;
  for (const [phone, conv] of conversations) {
    const score = matchScore(conv.name.toLowerCase(), name);
    if (score > bestScore) { bestScore = score; best = { phone, name: conv.name, chatId: conv.chatId }; }
  }
  if (best && bestScore >= 2) {
    console.log(`[bridge] resolve "${raw}" → ${best.name} (${best.phone}) score=${bestScore}`);
    return res.json(best);
  }

  // 2. Search WhatsApp contacts
  if (!isConnected) return res.status(503).json({ error: 'not connected' });
  try {
    const contacts = await client.getContacts();
    let bestContact = null, bestContactScore = 0;
    for (const c of contacts) {
      const cname = (c.pushname || c.name || '').toLowerCase();
      if (!cname) continue;
      const score = matchScore(cname, name);
      if (score > bestContactScore) { bestContactScore = score; bestContact = c; }
    }
    if (bestContact && bestContactScore >= 2) {
      return res.json({ phone: bestContact.id.user, name: bestContact.pushname || bestContact.name, chatId: bestContact.id._serialized });
    }
    // Fall back to best partial match only if nothing better exists
    if (best && bestScore >= 1) return res.json(best);
    return res.status(404).json({ error: `No contact found for "${raw}"` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Toggle twin on/off for a contact
app.post('/conversations/:phone/twin', (req, res) => {
  const conv = conversations.get(req.params.phone);
  if (!conv) return res.status(404).json({ error: 'not found' });
  conv.twinEnabled = !conv.twinEnabled;
  console.log(`[bridge] Twin ${conv.twinEnabled ? 'enabled' : 'disabled'} for ${conv.name}`);
  res.json({ ok: true, twinEnabled: conv.twinEnabled });
});

// ── Sync endpoints ─────────────────────────────────────────────────────────────

app.get('/sync/status', (req, res) => {
  res.json(syncState);
});

// Lightweight chat listing — used by the frontend to let the owner pick
// which contacts to import, without fetching full message history for each.
app.get('/sync/chats', async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected to WhatsApp' });

  // Serve from cache instantly — getChats walks every chat sequentially and
  // can take minutes on a small VM, far beyond what a UI request tolerates.
  // A stale cache triggers a background refresh (stale-while-revalidate).
  if (chatListCache) {
    if (Date.now() - chatListCache.at > CHAT_LIST_TTL_MS) refreshChatList();
    return res.json(chatListCache.list);
  }

  try {
    await refreshChatList();
    if (!chatListCache) throw new Error('chat list unavailable');
    res.json(chatListCache.list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import a single chat by phone — used by the Contacts page's "Add to chat" button
app.post('/sync/chat', async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected to WhatsApp' });
  const phone    = req.body.phone;
  const category = req.body.category || 'other';
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  try {
    const chats = await client.getChats();
    const chat = chats.find(c => c.id.user === phone);
    if (!chat) return res.status(404).json({ error: 'Chat not found for this phone' });

    const workspaceId = await getWorkspaceId();
    const result = await importOneChat(chat, category, workspaceId);

    if (result.status === 'error') return res.status(502).json({ error: result.error });
    if (result.status === 'empty') return res.status(422).json({ error: 'This chat has no importable messages' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/sync/start', async (req, res) => {
  if (syncState.running) return res.status(409).json({ error: 'Sync already running' });
  if (!isConnected)      return res.status(503).json({ error: 'Not connected to WhatsApp' });
  const category = req.body.category || 'customer';
  const phones   = Array.isArray(req.body.phones) ? req.body.phones : null;
  runSync(category, phones).catch(e => { syncState.running = false; syncLog(`Fatal: ${e?.message || String(e)}`); console.error('[sync] Fatal error:', e); });
  res.json({ ok: true, message: 'Sync started' });
});

// Demo sync — loads fake data through real pipeline (no WhatsApp needed)
app.post('/demo/sync', (req, res) => {
  if (syncState.running) return res.status(409).json({ error: 'Sync already running' });
  runDemoSync().catch(e => { syncState.running = false; syncLog(`Fatal: ${e.message}`); });
  res.json({ ok: true, message: 'Demo sync started' });
});

// Demo status
app.get('/demo/status', (req, res) => {
  res.json({ demoMode, conversations: conversations.size });
});

// Direct send — called by FastAPI for owner-instructed messages
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  try {
    await sendMessage(to, message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Starts the WhatsApp client once — safe to call repeatedly.
// We own this profile exclusively — one bridge per workspace — so any Chrome
// still holding it is an orphan from a killed bridge (kill -9 on node doesn't
// cascade to child Chrome). Execute it and clear the profile lock files, or
// every launch fails with "The browser is already running".
function clearStaleBrowserLock() {
  const sessionDir = path.join(__dirname, '.wwebjs_auth', `session-${CLIENT_ID}`);
  if (!fs.existsSync(sessionDir)) return;
  try {
    if (process.platform !== 'win32') {
      execSync(`pkill -9 -f -- "${sessionDir}"`, { stdio: 'ignore' });
    }
  } catch {} // pkill exits non-zero when nothing matched — fine
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(sessionDir, f), { force: true }); } catch {}
  }
}

function startClient() {
  if (initStarted) return;
  initStarted = true;
  initError   = null;
  clearStaleBrowserLock();
  client.initialize().catch(async e => {
    console.error('[bridge] Init error (will retry in 5s):', e.message);
    initError = e.message;
    try { await client.destroy(); } catch {}
    clearStaleBrowserLock();
    setTimeout(() => client.initialize().catch(err => { initStarted = false; initError = err.message; }), 5000);
  });
}

app.listen(PORT, async () => {
  console.log(`[bridge] HTTP server on port ${PORT}`);
  const workspaceId = await getWorkspaceId();
  await rehydrateInbox(workspaceId);

  // Only auto-start if this number was linked before (session on disk) —
  // otherwise starting the client just spins an endless QR refresh loop.
  // A fresh number waits for POST /connect from the UI.
  const sessionDir = path.join(__dirname, '.wwebjs_auth', `session-${CLIENT_ID}`);
  if (fs.existsSync(sessionDir)) {
    console.log('[bridge] Existing session found — reconnecting…');
    startClient();
  } else {
    console.log('[bridge] No saved session — waiting for a connect request before generating QR');
  }
});