const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const FormData = require('form-data');
const fetch = require('node-fetch');

const BACKEND_URL = 'http://localhost:8000';
const CATEGORY = 'customer';   // default — change to 'team' / 'supplier' / 'other' as needed
const DELAY_MS  = 600;         // pause between uploads so the backend isn't flooded

// ─── Format a chat's messages into the WhatsApp Android export .txt format ───

function formatTimestamp(unixTs) {
  const d = new Date(unixTs * 1000);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy}, ${hh}:${mi}`;
}

function senderLabel(msg, chatName) {
  if (msg.fromMe) return 'Me';
  // group messages carry the author field; direct messages use the chat name
  if (msg.author) return msg.author.replace(/@.*$/, '');
  return chatName;
}

function formatChat(chatName, messages) {
  const lines = [];
  for (const msg of messages) {
    const ts = formatTimestamp(msg.timestamp);
    const sender = senderLabel(msg, chatName);
    if (['ptt', 'audio'].includes(msg.type)) {
      lines.push(`${ts} - ${sender}: <Voice note omitted>`);
    } else if (msg.type === 'image' || msg.type === 'video') {
      lines.push(`${ts} - ${sender}: <Media omitted>`);
    } else if (msg.body) {
      lines.push(`${ts} - ${sender}: ${msg.body}`);
    }
  }
  return lines.join('\n');
}

// ─── Backend helpers ──────────────────────────────────────────────────────────

async function getWorkspaceId() {
  const res = await fetch(`${BACKEND_URL}/api/workspace/default`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.id;
}

async function uploadChat(chatName, content, workspaceId) {
  const form = new FormData();
  form.append('file', Buffer.from(content, 'utf-8'), {
    filename: `${chatName.replace(/[<>:"/\\|?*]/g, '_')}.txt`,
    contentType: 'text/plain',
  });
  form.append('category', CATEGORY);
  form.append('workspace_id', String(workspaceId));

  const res = await fetch(`${BACKEND_URL}/api/upload/parse`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.slice(0, 120));
  }
  return await res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── WhatsApp client ──────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', qr => {
  console.log('\nScan this QR code with your WhatsApp app:\n');
  qrcode.generate(qr, { small: true });
  console.log('Waiting for scan…\n');
});

client.on('authenticated', () => console.log('✓  Authenticated\n'));

client.on('ready', async () => {
  console.log('✓  Connected to WhatsApp\n');

  let workspaceId;
  try {
    workspaceId = await getWorkspaceId();
    console.log(`✓  Backend reachable — workspace #${workspaceId}\n`);
  } catch (e) {
    console.error(`✗  Cannot reach backend at ${BACKEND_URL} — is the FastAPI server running?`);
    process.exit(1);
  }

  const chats = await client.getChats();
  console.log(`Found ${chats.length} chats. Starting bulk export…\n`);

  let done = 0, skipped = 0, failed = 0;

  for (const chat of chats) {
    const name = chat.name || chat.id.user;
    process.stdout.write(`  ${name} … `);

    try {
      const messages = await chat.fetchMessages({ limit: Infinity });

      if (messages.length === 0) {
        console.log('(empty, skipped)');
        skipped++;
        continue;
      }

      const content = formatChat(name, messages);
      const result  = await uploadChat(name, content, workspaceId);
      console.log(`✓  ${messages.length} msgs  →  job #${result.job_id}`);
      done++;
    } catch (e) {
      console.log(`✗  ${e.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log('\n──────────────────────────────────────');
  console.log(`${done} chats exported · ${skipped} empty · ${failed} failed`);
  console.log(`\nOpen your dashboard: http://localhost:3000/dashboard\n`);

  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', msg => {
  console.error('✗  Auth failed:', msg);
  process.exit(1);
});

console.log('Starting WhatsApp exporter…');
client.initialize();
