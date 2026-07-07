const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode         = require('qrcode');
const express        = require('express');
const cors           = require('cors');
const fetch          = require('node-fetch');
const FormData       = require('form-data');

const BACKEND_URL    = process.env.BACKEND_URL    || 'http://localhost:8000';
const PORT           = process.env.BRIDGE_PORT    || 3001;
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET  || 'twin-bridge-default-change-me';
const DAILY_LIMIT  = 40;
const WARN_AT      = 30;
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 10000;

// ── State ──────────────────────────────────────────────────────────────────────

let qrDataUrl    = null;
let isConnected  = false;
let phoneInfo    = null;
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

  let workspaceId = 1;
  try {
    const r = await fetch(`${BACKEND_URL}/api/workspace/default`);
    const d = await r.json();
    workspaceId = d.id;
  } catch { syncLog('Could not fetch workspace id — using 1'); }

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
// string — simpler, and the backend stores message_type separately anyway.
function toStructuredEntry(msg, chatName) {
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

  return { timestamp: msg.timestamp, sender, body, message_type: type };
}

// ── Sync job — uploads chat history to the KB ──────────────────────────────

async function runSync(category = 'customer', selectedPhones = null) {
  if (syncState.running) return;
  if (!isConnected)      throw new Error('Not connected to WhatsApp');

  // Clear existing inbox so re-sync always starts fresh
  conversations.clear();

  Object.assign(syncState, { running: true, total: 0, done: 0, failed: 0, skipped: 0, current: null, log: [], finishedAt: null });

  // get workspace id
  let workspaceId = 1;
  try {
    const r = await fetch(`${BACKEND_URL}/api/workspace/default`);
    const d = await r.json();
    workspaceId = d.id;
  } catch { syncLog('Could not fetch workspace id — using 1'); }

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
    const name  = chat.name || chat.id.user;
    const phone = chat.id.user;
    syncState.current = name;

    // Register every contact in the conversations map so sends can resolve them by name
    if (!conversations.has(phone)) {
      conversations.set(phone, mkConv(phone, name, chat.id._serialized));
    } else {
      const conv = conversations.get(phone);
      conv.name   = name;
      conv.chatId = chat.id._serialized; // refresh serialized ID (handles LID rotation)
    }

    try {
      const rawMessages = await chat.fetchMessages({ limit: 50 });

      if (rawMessages.length === 0) {
        syncLog(`${name} — empty, skipped`);
        syncState.skipped++;
        syncState.done++;
        continue;
      }

      const structured = rawMessages
        .map(m => toStructuredEntry(m, name))
        .filter(Boolean);

      if (structured.length === 0) {
        // Messages were fetched but none were recognizable content
        // (pure notifications/system events) — nothing useful to import.
        syncLog(`${name} — no usable content, skipped`);
        syncState.skipped++;
        syncState.done++;
        continue;
      }

      const res = await fetch(`${BACKEND_URL}/api/upload/import-messages`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
        body:    JSON.stringify({ chat_name: name, category, workspace_id: workspaceId, messages: structured }),
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
        }));
        conv.updatedAt = conv.messages.length
          ? conv.messages[conv.messages.length - 1].timestamp
          : conv.updatedAt;
      }

      syncLog(`${name} — ✓ ${structured.length} msgs → job #${result.job_id}`);
      syncState.done++;
    } catch (e) {
      syncLog(`${name} — ✗ ${e.message}`);
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

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth', clientId: `port-${PORT}` }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', async qr => {
  qrcodeTerminal.generate(qr, { small: true });
  qrDataUrl = await QRCode.toDataURL(qr);
  console.log('[bridge] QR ready — scan with WhatsApp');
});

client.on('authenticated', () => {
  qrDataUrl = null;
  console.log('[bridge] Authenticated');
});

client.on('ready', async () => {
  isConnected = true;
  qrDataUrl   = null;
  const info  = client.info;
  phoneInfo   = { number: info.wid.user, name: info.pushname, platform: info.platform };
  console.log(`[bridge] Ready — ${phoneInfo.name} (${phoneInfo.number})`);
  await notifyBackend('connected', phoneInfo);
});

client.on('disconnected', async reason => {
  isConnected = false;
  phoneInfo   = null;
  console.log('[bridge] Disconnected:', reason);
  await notifyBackend('disconnected', { reason });
});

client.on('message', async msg => {
  if (msg.from === 'status@broadcast') return;
  if (msg.from.endsWith('@g.us')) return; // skip groups for now

  const phone   = msg.from.replace('@c.us', '');
  const contact = await msg.getContact();
  const name    = contact.pushname || contact.name || phone;

  seenSenders.add(phone);

  if (!conversations.has(phone)) conversations.set(phone, mkConv(phone, name, msg.from));
  const conv = conversations.get(phone);
  conv.name   = name;
  conv.chatId = msg.from; // always use the actual serialized ID from the message
  conv.messages.push({ role: 'customer', content: msg.body, timestamp: new Date(msg.timestamp * 1000).toISOString() });
  conv.draftReply = null;
  conv.status     = 'needs_reply';
  conv.updatedAt  = new Date().toISOString();

  console.log(`[bridge] Inbound from ${name} (${phone}): "${msg.body.slice(0, 60)}"`);

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
    phone:        phoneInfo,
    daily_sent:   dailySent,
    daily_limit:  DAILY_LIMIT,
    warn_at:      WARN_AT,
    seen_senders: seenSenders.size,
  });
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
  try {
    const chats = await client.getChats();
    const list = chats.map(c => ({
      phone:            c.id.user,
      name:             c.name || c.id.user,
      isGroup:          !!c.isGroup,
      lastMessage:      c.lastMessage ? c.lastMessage.body : null,
      lastMessageAt:    c.timestamp ? new Date(c.timestamp * 1000).toISOString() : null,
      unreadCount:      c.unreadCount || 0,
    })).sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/sync/start', async (req, res) => {
  if (syncState.running) return res.status(409).json({ error: 'Sync already running' });
  if (!isConnected)      return res.status(503).json({ error: 'Not connected to WhatsApp' });
  const category = req.body.category || 'customer';
  const phones   = Array.isArray(req.body.phones) ? req.body.phones : null;
  runSync(category, phones).catch(e => { syncState.running = false; syncLog(`Fatal: ${e.message}`); });
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

app.listen(PORT, () => {
  console.log(`[bridge] HTTP server on port ${PORT}`);
  client.initialize();
});