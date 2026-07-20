"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import { apiFetch, getUser } from "@/lib/auth";

// ── Types ──────────────────────────────────────────────────────────────────────

interface BridgeStatus {
  connected: boolean;
  qr: string | null;
  phone: { number: string; name: string } | null;
  daily_sent: number;
  daily_limit: number;
  error?: string;
}

interface ConvMessage { role: "customer" | "agent"; content: string; timestamp: string; }
interface Conversation {
  id: string; name: string; messages: ConvMessage[];
  draftReply: string | null; status: "active" | "needs_reply" | "draft_ready" | "replied";
  twinEnabled: boolean; updatedAt: string;
}

interface StyleProfile {
  exists: boolean;
  summary?: string;
  message_count?: number;
  generated_at?: string;
}

interface OwnerMessage {
  role: "user" | "assistant";
  content: string;
  analyticsData?: { metric: string; data: unknown };
  sendPreview?: { to: string; message: string };
  streaming?: boolean;
}

interface SyncState {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  current: string | null;
  log: string[];
  finishedAt: string | null;
  error?: string;
}

interface Overview {
  total_messages: number;
  total_chats:    number;
  total_contacts: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  needs_reply: "#f59e0b", draft_ready: "#22c55e", replied: "#3f3f46", active: "#27272a",
};
const STATUS_LABELS: Record<string, string> = {
  needs_reply: "Needs reply", draft_ready: "Draft ready", replied: "Replied", active: "Active",
};

function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase(); }
function fmt(iso: string) { return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
function isArabic(t: string) { return /[؀-ۿ]/.test(t); }

function formatDay(d: Date): string {
  const today     = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString())     return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtLastSync(iso: string): string {
  const d      = new Date(iso);
  const now    = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1)  return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `${diffH}h ago`;
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

// ── Analytics card ─────────────────────────────────────────────────────────────

function AnalyticsCard({ metric, data }: { metric: string; data: unknown }) {
  const d = data as Record<string, unknown>;

  if (metric === "overview") {
    const cats = (d.categories as { category: string; chats: number; messages: number }[]) ?? [];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {[
            { label: "Messages", value: (d.total_messages as number)?.toLocaleString() },
            { label: "Chats",    value: (d.total_chats    as number)?.toLocaleString() },
            { label: "Contacts", value: (d.total_contacts as number)?.toLocaleString() },
          ].map(s => (
            <div key={s.label} style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 8, padding: "10px 14px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#22c55e" }}>{s.value ?? "—"}</div>
              <div style={{ fontSize: 10, color: "#52525b", marginTop: 2, letterSpacing: "0.08em", textTransform: "uppercase" }}>{s.label}</div>
            </div>
          ))}
        </div>
        {cats.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {cats.map(c => (
              <span key={c.category} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: "#18181b", color: "#71717a", border: "1px solid #27272a" }}>
                {c.category}: {c.chats} chats · {c.messages.toLocaleString()} msgs
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (metric === "top_contacts") {
    const contacts = (d.contacts as { id: number; name: string; messages: number }[]) ?? [];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {contacts.slice(0, 6).map((c, i) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid #1f1f23" }}>
            <span style={{ fontSize: 11, color: "#3f3f46", width: 16, fontFamily: "'Fira Code', monospace" }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 13, color: "#fafaf9" }}>{c.name}</span>
            <span style={{ fontSize: 11, color: "#52525b", fontFamily: "'Fira Code', monospace" }}>{c.messages.toLocaleString()} msgs</span>
          </div>
        ))}
      </div>
    );
  }

  if (metric === "intents") {
    const intents = (d.intents as { tag: string; count: number }[]) ?? [];
    const max = intents[0]?.count || 1;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {intents.slice(0, 7).map(it => (
          <div key={it.tag}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 12, color: "#fafaf9" }}>{it.tag}</span>
              <span style={{ fontSize: 11, color: "#52525b", fontFamily: "'Fira Code', monospace" }}>{it.count}</span>
            </div>
            <div style={{ height: 2, borderRadius: 1, background: "#27272a" }}>
              <div style={{ height: 2, borderRadius: 1, background: "#22c55e", width: `${(it.count / max) * 100}%`, transition: "width 0.4s" }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

// ── Twin toggle ────────────────────────────────────────────────────────────────

function TwinToggle({ on, loading, onClick }: { on: boolean; loading: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      title={on ? "Twin ON — click to disable" : "Twin OFF — click to enable"}
      style={{ background: "none", border: "none", padding: 0, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.5 : 1, display: "flex", alignItems: "center", gap: 5 }}
    >
      {loading ? (
        <div style={{ width: 30, height: 17, borderRadius: 9, background: "#27272a", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", border: "1.5px solid #3f3f46", borderTopColor: "#22c55e" }} className="kb-spin" />
        </div>
      ) : (
        <div style={{ width: 30, height: 17, borderRadius: 9, background: on ? "#22c55e" : "#27272a", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
          <div style={{ width: 13, height: 13, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: on ? 15 : 2, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }} />
        </div>
      )}
      <span style={{ fontSize: 9, color: on ? "#22c55e" : "#3f3f46", letterSpacing: "0.06em", fontFamily: "'Fira Code', monospace" }}>
        {on ? "ON" : "OFF"}
      </span>
    </button>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AgentPage() {
  const [bridgeStatus,   setBridgeStatus]   = useState<BridgeStatus | null>(null);
  const [conversations,  setConversations]  = useState<Conversation[]>([]);
  const [selected,       setSelected]       = useState<string | null>(null);
  const [ownerMsgs,      setOwnerMsgs]      = useState<OwnerMessage[]>([]);
  const [input,          setInput]          = useState("");
  const [streaming,      setStreaming]       = useState(false);
  const [workspaceId,    setWorkspaceId]    = useState<number>(1);
  const [showQR,         setShowQR]         = useState(false);
  const [showSync,       setShowSync]       = useState(false);
  const [syncChats,        setSyncChats]        = useState<{ phone: string; name: string; isGroup: boolean; lastMessage: string | null }[] | null>(null);
  const [syncChatsLoading, setSyncChatsLoading]  = useState(false);
  const [selectedPhones,   setSelectedPhones]    = useState<Set<string>>(new Set());
  const [chatSearch,       setChatSearch]        = useState("");
  const [showSettings,   setShowSettings]   = useState(false);
  const [syncState,      setSyncState]      = useState<SyncState | null>(null);
  const [syncCategory,   setSyncCategory]   = useState("customer");
  const [styleProfile,   setStyleProfile]   = useState<StyleProfile | null>(null);
  const [learningStyle,  setLearningStyle]  = useState(false);
  const [togglingTwin,   setTogglingTwin]   = useState<Set<string>>(new Set());
  const [regenerating,   setRegenerating]   = useState<Set<string>>(new Set());
  const [editingPreview, setEditingPreview] = useState<Record<number, string>>({});
  const [editingDraft,   setEditingDraft]   = useState<Record<string, string>>({});
  const [signature,      setSignature]      = useState("");
  const [showSigEdit,    setShowSigEdit]    = useState(false);
  const [searchQuery,    setSearchQuery]    = useState("");
  const [inboxFilter,    setInboxFilter]    = useState<"all" | "needs_reply" | "draft_ready">("all");
  const [lastSyncTime,   setLastSyncTime]   = useState<string | null>(null);
  const [overview,       setOverview]       = useState<Overview | null>(null);
  const [demoLoading,    setDemoLoading]    = useState(false);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLTextAreaElement>(null);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data loaders ─────────────────────────────────────────────────────────────

  const pollStatus = useCallback(async () => {
    try {
      const r = await apiFetch("/api/whatsapp/status");
      setBridgeStatus(await r.json());
    } catch {
      setBridgeStatus({ connected: false, qr: null, phone: null, daily_sent: 0, daily_limit: 40, error: "unreachable" });
    }
  }, []);

  const pollConversations = useCallback(async () => {
    try {
      const r = await apiFetch("/api/whatsapp/conversations");
      const data = await r.json();
      if (Array.isArray(data)) setConversations(data);
    } catch { /* ignore */ }
  }, []);

  const pollSync = useCallback(async () => {
    try {
      const r = await apiFetch("/api/whatsapp/sync/status");
      const data: SyncState = await r.json();
      setSyncState(data);
      if (data.finishedAt) setLastSyncTime(data.finishedAt);
      if (!data.running && syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
        pollConversations();
      }
    } catch { /* ignore */ }
  }, [pollConversations]);

  const loadStyleProfile = useCallback(async () => {
    try {
      const r = await apiFetch("/api/style");
      const data = await r.json();
      setStyleProfile(data);
      if (data?.signature) setSignature(data.signature);
    } catch { /* ignore */ }
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/analytics/overview?workspace_id=${workspaceId}`);
      const data = await r.json();
      setOverview(data);
    } catch { /* ignore */ }
  }, [workspaceId]);

  useEffect(() => {
    // Superadmin is a platform manager, not a chat operator — no bridge/inbox
    // view for them (it would surface some tenant's connection as "theirs")
    if (getUser()?.role === "superadmin") { window.location.href = "/users"; return; }

    const stored = typeof window !== "undefined" ? localStorage.getItem("workspace_id") : null;
    if (stored) setWorkspaceId(Number(stored));
    else apiFetch("/api/workspace/default").then(r => r.json()).then(d => {
      setWorkspaceId(d.id);
      localStorage.setItem("workspace_id", String(d.id));
    }).catch(() => {});

    pollStatus();
    pollConversations();
    pollSync();
    loadStyleProfile();
    const t1 = setInterval(pollStatus, 8000);
    const t2 = setInterval(pollConversations, 3000);
    return () => { clearInterval(t1); clearInterval(t2); if (syncPollRef.current) clearInterval(syncPollRef.current); };
  }, [pollStatus, pollConversations, pollSync, loadStyleProfile]);

  // While the QR modal is open, poll faster — a freshly auto-started bridge
  // (fresh Puppeteer/Chrome boot) can take several seconds to produce a QR,
  // and the background 8s cadence would feel sluggish for that window.
  useEffect(() => {
    if (!showQR) return;
    pollStatus();
    const t = setInterval(pollStatus, 2000);
    return () => clearInterval(t);
  }, [showQR, pollStatus]);

  // Auto-close the QR modal the instant a connection is confirmed — covers
  // both a saved session reconnecting on its own (no scan needed) and a
  // fresh scan succeeding, so it never has to be closed manually.
  useEffect(() => {
    if (showQR && bridgeStatus?.connected) {
      setShowQR(false);
    }
  }, [showQR, bridgeStatus?.connected]);

  useEffect(() => { if (workspaceId) loadOverview(); }, [workspaceId, loadOverview]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [ownerMsgs]);

  // ── Style & settings ──────────────────────────────────────────────────────────

  async function learnStyle() {
    if (learningStyle) return;
    setLearningStyle(true);
    try {
      const r = await apiFetch(`/api/style/learn?workspace_id=${workspaceId}`, { method: "POST" });
      const data = await r.json();
      setStyleProfile(data);
    } catch { /* ignore */ }
    finally { setLearningStyle(false); }
  }

  async function saveSig() {
    await apiFetch("/api/style/signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature }),
    });
    setShowSigEdit(false);
  }

  // ── Twin toggle ───────────────────────────────────────────────────────────────

  async function toggleTwin(phone: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (togglingTwin.has(phone)) return;
    setTogglingTwin(prev => new Set(prev).add(phone));
    try {
      await apiFetch(`/api/whatsapp/toggle/${phone}`, { method: "POST" });
      await pollConversations();
    } catch { /* ignore */ }
    finally { setTogglingTwin(prev => { const s = new Set(prev); s.delete(phone); return s; }); }
  }

  // ── Sync ──────────────────────────────────────────────────────────────────────

  async function loadSyncChats() {
    setSyncChatsLoading(true);
    try {
      const r = await apiFetch("/api/whatsapp/sync/chats");
      if (r.ok) {
        const data = await r.json();
        setSyncChats(data);
        setSelectedPhones(new Set(data.map((c: { phone: string }) => c.phone))); // default: all selected
      } else {
        setSyncChats([]);
      }
    } catch { setSyncChats([]); }
    finally { setSyncChatsLoading(false); }
  }

  function toggleChatSelected(phone: string) {
    setSelectedPhones(prev => {
      const n = new Set(prev);
      if (n.has(phone)) n.delete(phone); else n.add(phone);
      return n;
    });
  }

  async function startSync() {
    const allSelected = syncChats != null && selectedPhones.size === syncChats.length;
    await apiFetch("/api/whatsapp/sync/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: syncCategory,
        // Omit phones entirely when everything is selected (or list hasn't loaded) — imports all chats.
        phones: (syncChats && !allSelected) ? Array.from(selectedPhones) : undefined,
      }),
    });
    setSyncState(s => s ? { ...s, running: true } : { running: true, total: 0, done: 0, failed: 0, skipped: 0, current: null, log: [], finishedAt: null });
    if (syncPollRef.current) clearInterval(syncPollRef.current);
    syncPollRef.current = setInterval(pollSync, 1200);
  }

  async function startDemoSync() {
    if (demoLoading) return;
    setDemoLoading(true);
    try {
      await apiFetch("/api/whatsapp/demo/sync", { method: "POST" });
      setShowSync(true);
      setSyncState({ running: true, total: 85, done: 0, failed: 0, skipped: 0, current: "Loading demo data…", log: [], finishedAt: null });
      if (syncPollRef.current) clearInterval(syncPollRef.current);
      syncPollRef.current = setInterval(pollSync, 800);
    } catch { /* ignore */ }
    finally { setDemoLoading(false); }
  }

  // ── Owner chat ────────────────────────────────────────────────────────────────

  async function sendOwnerQuery(q?: string) {
    const text = (q ?? input).trim();
    if (!text || streaming) return;
    setInput("");
    setOwnerMsgs(prev => [...prev,
      { role: "user",      content: text },
      { role: "assistant", content: "", streaming: true },
    ]);
    setStreaming(true);

    try {
      const res = await apiFetch("/api/agent/owner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text, workspace_id: workspaceId }),
      });
      const reader = res.body!.getReader();
      const dec    = new TextDecoder();
      let buf      = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;
          try {
            const ev = JSON.parse(raw);
            setOwnerMsgs(prev => {
              const n    = [...prev];
              const last = { ...n[n.length - 1] };
              if (ev.type === "chunk")        last.content += ev.text;
              if (ev.type === "analytics")    last.analyticsData = { metric: ev.metric, data: ev.data };
              if (ev.type === "send_preview") last.sendPreview   = { to: ev.to, message: ev.message };
              if (ev.type === "done")         last.streaming     = false;
              n[n.length - 1] = last;
              return n;
            });
          } catch { /* skip */ }
        }
      }
    } catch {
      setOwnerMsgs(prev => { const n = [...prev]; n[n.length - 1] = { ...n[n.length - 1], content: "Could not reach backend.", streaming: false }; return n; });
    } finally {
      setStreaming(false);
      setOwnerMsgs(prev => { const n = [...prev]; if (n[n.length - 1]?.streaming) n[n.length - 1] = { ...n[n.length - 1], streaming: false }; return n; });
      inputRef.current?.focus();
    }
  }

  async function confirmSend(to: string, message: string, msgIdx: number) {
    try {
      const r = await apiFetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, message }),
      });
      const data = await r.json();
      if (data?.error) {
        setOwnerMsgs(prev => prev.map((m, i) =>
          i === msgIdx ? { ...m, content: (m.content ? m.content + "\n\n" : "") + `⚠ ${data.error}` } : m
        ));
      } else {
        const label = data?.resolved_name && data?.resolved_phone
          ? `${data.resolved_name} (+${data.resolved_phone})` : to;
        setOwnerMsgs(prev => prev.map((m, i) =>
          i === msgIdx ? { ...m, sendPreview: undefined, content: (m.content ? m.content + "\n\n" : "") + `✓ Sent to ${label}` } : m
        ));
        loadOverview();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to send";
      setOwnerMsgs(prev => prev.map((m, i) =>
        i === msgIdx ? { ...m, content: (m.content ? m.content + "\n\n" : "") + `⚠ ${msg}` } : m
      ));
    }
  }

  async function approveDraft(phone: string, editedText?: string) {
    if (editedText !== undefined) {
      await apiFetch(`/api/whatsapp/${phone}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: editedText }),
      });
    }
    await apiFetch(`/api/whatsapp/approve/${phone}`, { method: "POST" });
    setEditingDraft(p => { const n = { ...p }; delete n[phone]; return n; });
    await pollConversations();
    loadOverview();
  }

  async function rejectDraft(phone: string) {
    await apiFetch(`/api/whatsapp/reject/${phone}`, { method: "POST" });
    setEditingDraft(p => { const n = { ...p }; delete n[phone]; return n; });
    await pollConversations();
  }

  async function regenerateDraft(phone: string) {
    if (regenerating.has(phone)) return;
    setRegenerating(prev => new Set(prev).add(phone));
    try {
      await apiFetch(`/api/whatsapp/regenerate/${phone}`, { method: "POST" });
      // Draft is generated in the background — poll a few times to pick it up.
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await pollConversations();
      }
    } finally {
      setRegenerating(prev => { const n = new Set(prev); n.delete(phone); return n; });
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────────

  const filteredConvs = conversations.filter(c => {
    if (searchQuery && !c.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (inboxFilter === "needs_reply" && c.status !== "needs_reply") return false;
    if (inboxFilter === "draft_ready" && c.status !== "draft_ready") return false;
    return true;
  });

  const selectedConv = conversations.find(c => c.id === selected) ?? null;
  const needsReply   = conversations.filter(c => c.status === "needs_reply").length;
  const draftReady   = conversations.filter(c => c.status === "draft_ready").length;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* ── Top bar: bridge status + controls ────────────────────────────── */}
        <div style={{ height: 48, background: "#111113", borderBottom: "1px solid #1f1f23", padding: "0 16px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>

          {/* Status */}
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: bridgeStatus?.connected ? "#22c55e" : "#3f3f46",
              boxShadow: bridgeStatus?.connected ? "0 0 6px rgba(34,197,94,0.5)" : "none",
            }} />
            <span style={{ fontSize: 12, color: "#71717a" }}>
              {bridgeStatus?.connected
                ? `${bridgeStatus.phone?.name ?? "Connected"} · +${bridgeStatus.phone?.number}`
                : bridgeStatus?.error ? "Bridge offline" : "Not connected"}
            </span>
          </div>

          {bridgeStatus?.connected && (
            <span style={{ fontSize: 11, color: bridgeStatus.daily_sent >= 30 ? "#f59e0b" : "#3f3f46", fontFamily: "'Fira Code', monospace" }}>
              {bridgeStatus.daily_sent}/{bridgeStatus.daily_limit}
            </span>
          )}

          {!bridgeStatus?.connected && (
            <button onClick={() => { apiFetch("/api/whatsapp/connect", { method: "POST" }).catch(() => {}); setShowQR(true); }} style={{ fontSize: 12, color: "#22c55e", background: "none", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
              Connect WhatsApp
            </button>
          )}

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {needsReply > 0 && (
              <span style={{ fontSize: 11, background: "rgba(245,158,11,0.12)", color: "#f59e0b", borderRadius: 10, padding: "2px 8px", border: "1px solid rgba(245,158,11,0.2)" }}>
                {needsReply} need reply
              </span>
            )}
            {draftReady > 0 && (
              <span style={{ fontSize: 11, background: "rgba(34,197,94,0.10)", color: "#22c55e", borderRadius: 10, padding: "2px 8px", border: "1px solid rgba(34,197,94,0.2)" }}>
                {draftReady} draft{draftReady !== 1 ? "s" : ""} ready
              </span>
            )}

            {bridgeStatus?.connected && (
              <button onClick={() => { setShowSync(true); if (!syncState?.running && !syncState?.finishedAt) loadSyncChats(); }} style={{ fontSize: 11, color: "#52525b", background: "none", border: "1px solid #27272a", borderRadius: 6, padding: "3px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
                onMouseEnter={e => (e.currentTarget.style.color = "#a1a1aa")}
                onMouseLeave={e => (e.currentTarget.style.color = "#52525b")}
              >
                {syncState?.running
                  ? <><div style={{ width: 8, height: 8, borderRadius: "50%", border: "1.5px solid #27272a", borderTopColor: "#22c55e" }} className="kb-spin" /> {syncState.done}/{syncState.total}</>
                  : lastSyncTime ? `Synced ${fmtLastSync(lastSyncTime)}` : "Import history"
                }
              </button>
            )}

            <button
              onClick={startDemoSync}
              disabled={demoLoading || (syncState?.running ?? false)}
              title="Load sample contacts — no WhatsApp needed"
              style={{ fontSize: 11, color: "#52525b", background: "none", border: "1px solid #27272a", borderRadius: 6, padding: "3px 10px", cursor: (demoLoading || syncState?.running) ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 5, opacity: (demoLoading || syncState?.running) ? 0.4 : 1 }}
              onMouseEnter={e => { if (!(demoLoading || syncState?.running)) e.currentTarget.style.color = "#a1a1aa"; }}
              onMouseLeave={e => (e.currentTarget.style.color = "#52525b")}
            >
              {demoLoading
                ? <><div style={{ width: 8, height: 8, borderRadius: "50%", border: "1.5px solid #27272a", borderTopColor: "#52525b" }} className="kb-spin" /> Starting…</>
                : "Demo"
              }
            </button>

            <button
              onClick={() => setShowSettings(true)}
              title="Settings"
              style={{ width: 30, height: 30, borderRadius: 6, background: "transparent", border: "1px solid #27272a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#52525b", fontSize: 14, transition: "all 0.12s" }}
              onMouseEnter={e => { e.currentTarget.style.color = "#a1a1aa"; e.currentTarget.style.borderColor = "#3f3f46"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "#52525b"; e.currentTarget.style.borderColor = "#27272a"; }}
            >
              ⚙
            </button>
          </div>
        </div>

        {/* ── QR Modal ──────────────────────────────────────────────────────── */}
        {showQR && (
          <div onClick={() => setShowQR(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 16, padding: "36px 40px", width: 360, textAlign: "center" }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, color: "#fafaf9", marginBottom: 6 }}>Connect WhatsApp</h2>
              <p style={{ fontSize: 13, color: "#52525b", marginBottom: 24 }}>Open WhatsApp on your phone and scan the QR code</p>
              {bridgeStatus?.qr ? (
                <div style={{ display: "inline-block", background: "#fff", borderRadius: 10, padding: 12 }}>
                  <img src={bridgeStatus.qr} alt="QR" style={{ width: 200, height: 200, display: "block" }} />
                </div>
              ) : bridgeStatus?.error && !bridgeStatus.error.includes("Starting bridge") ? (
                <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ textAlign: "center", padding: "0 8px" }}>
                    <div style={{ fontSize: 20, marginBottom: 10 }}>⚠️</div>
                    <span style={{ color: "#f87171", fontSize: 13, lineHeight: 1.5, display: "block" }}>{bridgeStatus.error}</span>
                  </div>
                </div>
              ) : (
                <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid #27272a", borderTopColor: "#22c55e", margin: "0 auto 12px" }} className="kb-spin" />
                    <span style={{ color: "#52525b", fontSize: 13 }}>{bridgeStatus?.error || "Waiting for QR code…"}</span>
                  </div>
                </div>
              )}
              <button onClick={() => setShowQR(false)} style={{ marginTop: 24, fontSize: 13, color: "#52525b", background: "none", border: "none", cursor: "pointer" }}>Close</button>
            </div>
          </div>
        )}

        {/* ── Settings Panel ────────────────────────────────────────────────── */}
        {showSettings && (
          <div onClick={() => setShowSettings(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "stretch", justifyContent: "flex-end", zIndex: 50 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#111113", borderLeft: "1px solid #27272a", width: 340, padding: "24px 20px", display: "flex", flexDirection: "column", gap: 24, overflowY: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, color: "#fafaf9" }}>Settings</h2>
                <button onClick={() => setShowSettings(false)} style={{ fontSize: 20, color: "#52525b", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>

              {/* Writing style */}
              <div>
                <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase", fontWeight: 600 }}>Writing Style</div>
                {styleProfile?.exists && (
                  <div style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 8, padding: "10px 14px", marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, background: "rgba(34,197,94,0.12)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 20, padding: "2px 8px" }}>✓ Style learned</span>
                      <span style={{ fontSize: 10, color: "#3f3f46", fontFamily: "'Fira Code', monospace" }}>{styleProfile.message_count?.toLocaleString()} samples</span>
                    </div>
                    {styleProfile.summary && (
                      <p style={{ fontSize: 12, color: "#71717a", lineHeight: 1.5 }}>{styleProfile.summary}</p>
                    )}
                  </div>
                )}
                <button
                  onClick={learnStyle}
                  disabled={learningStyle}
                  style={{ width: "100%", padding: "9px 0", borderRadius: 8, background: learningStyle ? "#18181b" : "#22c55e", color: learningStyle ? "#52525b" : "#000", fontSize: 13, fontWeight: 600, border: "none", cursor: learningStyle ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                >
                  {learningStyle
                    ? <><div style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid #27272a", borderTopColor: "#52525b" }} className="kb-spin" /> Learning…</>
                    : styleProfile?.exists ? "↺ Re-learn my style" : "✦ Learn my style"
                  }
                </button>
              </div>

              {/* Signature */}
              <div>
                <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase", fontWeight: 600 }}>Signature</div>
                <p style={{ fontSize: 12, color: "#52525b", marginBottom: 8 }}>Appended to every AI-generated message</p>
                {showSigEdit ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      autoFocus
                      value={signature}
                      onChange={e => setSignature(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") saveSig(); if (e.key === "Escape") setShowSigEdit(false); }}
                      placeholder="e.g. – Sent via Twin"
                      style={{ flex: 1, fontSize: 12, padding: "8px 12px", border: "1px solid #22c55e", borderRadius: 7, outline: "none", background: "#18181b", color: "#fafaf9" }}
                    />
                    <button onClick={saveSig} style={{ padding: "8px 12px", borderRadius: 7, background: "#22c55e", color: "#000", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>Save</button>
                    <button onClick={() => setShowSigEdit(false)} style={{ padding: "8px 10px", borderRadius: 7, background: "transparent", color: "#71717a", fontSize: 12, border: "1px solid #27272a", cursor: "pointer" }}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setShowSigEdit(true)} style={{ width: "100%", textAlign: "left", padding: "9px 14px", borderRadius: 8, border: "1px solid #27272a", background: "#18181b", fontSize: 13, color: signature ? "#fafaf9" : "#3f3f46", cursor: "pointer" }}>
                    {signature ? `"${signature}"` : "Click to set signature…"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Sync Modal ────────────────────────────────────────────────────── */}
        {showSync && (
          <div onClick={() => !syncState?.running && setShowSync(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 16, padding: "28px 32px", width: 480, maxWidth: "90vw" }}>
              <h2 style={{ fontSize: 17, fontWeight: 600, color: "#fafaf9", marginBottom: 4 }}>Import chat history</h2>
              <p style={{ fontSize: 13, color: "#52525b", marginBottom: 20 }}>Fetches all WhatsApp conversations and indexes them into the knowledge base.</p>

              {!syncState?.running && !syncState?.finishedAt && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase", fontWeight: 600 }}>Default category</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {["customer", "team", "supplier", "other"].map(c => (
                        <button key={c} onClick={() => setSyncCategory(c)} style={{ padding: "5px 14px", borderRadius: 20, fontSize: 12, border: `1px solid ${syncCategory === c ? "#22c55e" : "#27272a"}`, background: syncCategory === c ? "rgba(34,197,94,0.12)" : "transparent", color: syncCategory === c ? "#22c55e" : "#71717a", cursor: "pointer" }}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>
                        Contacts {syncChats ? `(${selectedPhones.size}/${syncChats.length} selected)` : ""}
                      </div>
                      {syncChats && syncChats.length > 0 && (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => setSelectedPhones(new Set(syncChats.map(c => c.phone)))} style={{ fontSize: 10, color: "#52525b", background: "none", border: "none", cursor: "pointer" }}>All</button>
                          <button onClick={() => setSelectedPhones(new Set())} style={{ fontSize: 10, color: "#52525b", background: "none", border: "none", cursor: "pointer" }}>None</button>
                        </div>
                      )}
                    </div>

                    {syncChatsLoading ? (
                      <div style={{ padding: "20px 0", textAlign: "center" }}>
                        <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid #27272a", borderTopColor: "#22c55e", margin: "0 auto" }} className="kb-spin" />
                      </div>
                    ) : syncChats && syncChats.length > 0 ? (
                      <>
                        <input
                          value={chatSearch}
                          onChange={e => setChatSearch(e.target.value)}
                          placeholder="Search contacts…"
                          style={{ width: "100%", boxSizing: "border-box", fontSize: 12, color: "#fafaf9", background: "#09090b", border: "1px solid #27272a", borderRadius: 7, padding: "6px 10px", marginBottom: 8, outline: "none" }}
                        />
                        <div style={{ background: "#09090b", border: "1px solid #1f1f23", borderRadius: 8, maxHeight: 220, overflowY: "auto" }}>
                          {syncChats
                            .filter(c => c.name.toLowerCase().includes(chatSearch.toLowerCase()))
                            .map(c => (
                              <label key={c.phone} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid #18181b", cursor: "pointer" }}>
                                <input type="checkbox" checked={selectedPhones.has(c.phone)} onChange={() => toggleChatSelected(c.phone)} style={{ accentColor: "#22c55e", cursor: "pointer" }} />
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ fontSize: 12, color: "#e4e4e7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {c.name} {c.isGroup && <span style={{ color: "#3f3f46", fontSize: 10 }}>· group</span>}
                                  </div>
                                  {c.lastMessage && (
                                    <div style={{ fontSize: 10, color: "#3f3f46", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.lastMessage}</div>
                                  )}
                                </div>
                              </label>
                            ))}
                        </div>
                      </>
                    ) : (
                      <p style={{ fontSize: 11, color: "#3f3f46" }}>No chats found — will import everything available.</p>
                    )}
                  </div>

                  <button onClick={startSync} disabled={syncChats != null && syncChats.length > 0 && selectedPhones.size === 0} style={{ width: "100%", padding: "11px 0", borderRadius: 10, background: (syncChats && syncChats.length > 0 && selectedPhones.size === 0) ? "#27272a" : "#22c55e", color: (syncChats && syncChats.length > 0 && selectedPhones.size === 0) ? "#52525b" : "#000", fontSize: 14, fontWeight: 600, border: "none", cursor: (syncChats && syncChats.length > 0 && selectedPhones.size === 0) ? "not-allowed" : "pointer" }}>
                    {syncChats && selectedPhones.size > 0 && selectedPhones.size < syncChats.length
                      ? `Import ${selectedPhones.size} selected`
                      : "Start import"}
                  </button>
                </>
              )}

              {syncState?.running && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: "#a1a1aa" }}>{syncState.current ?? "Starting…"}</span>
                    <span style={{ fontSize: 12, color: "#52525b", fontFamily: "'Fira Code', monospace" }}>{syncState.done}/{syncState.total}</span>
                  </div>
                  <div style={{ height: 4, background: "#27272a", borderRadius: 2, marginBottom: 14 }}>
                    <div style={{ height: 4, background: "#22c55e", borderRadius: 2, width: syncState.total > 0 ? `${(syncState.done / syncState.total) * 100}%` : "3%", transition: "width 0.5s" }} />
                  </div>
                  <div style={{ background: "#09090b", borderRadius: 8, padding: "10px 14px", height: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                    {syncState.log.map((line, i) => (
                      <span key={i} style={{ fontFamily: "'Fira Code', monospace", fontSize: 10, color: line.includes("✗") ? "#f87171" : line.includes("✓") ? "#22c55e" : "#3f3f46" }}>{line}</span>
                    ))}
                  </div>
                </div>
              )}

              {syncState?.finishedAt && !syncState.running && (
                <div>
                  <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 8, padding: "12px 16px", marginBottom: 14 }}>
                    <p style={{ fontSize: 13, color: "#22c55e", fontWeight: 500 }}>
                      Import complete — {syncState.done - syncState.failed - syncState.skipped} contacts indexed
                    </p>
                    <p style={{ fontSize: 11, color: "#3f3f46", marginTop: 4, fontFamily: "'Fira Code', monospace" }}>
                      {syncState.skipped} empty · {syncState.failed} failed
                    </p>
                  </div>
                  <div style={{ background: "#09090b", borderRadius: 8, padding: "10px 14px", height: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                    {syncState.log.map((line, i) => (
                      <span key={i} style={{ fontFamily: "'Fira Code', monospace", fontSize: 10, color: line.includes("✗") ? "#f87171" : line.includes("✓") ? "#22c55e" : "#3f3f46" }}>{line}</span>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <button onClick={() => { setSyncState(null); setShowSync(false); setSyncChats(null); setChatSearch(""); loadOverview(); }} style={{ flex: 1, padding: "9px 0", borderRadius: 8, background: "#22c55e", color: "#000", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}>Done</button>
                    {bridgeStatus?.connected && (
                      <button onClick={() => { setSyncState(null); setChatSearch(""); loadSyncChats(); }} style={{ padding: "9px 18px", borderRadius: 8, background: "transparent", color: "#71717a", fontSize: 13, border: "1px solid #27272a", cursor: "pointer" }}>Re-sync</button>
                    )}
                  </div>
                </div>
              )}

              {!syncState?.running && (
                <button onClick={() => { setShowSync(false); setSyncChats(null); setChatSearch(""); }} style={{ marginTop: 14, fontSize: 12, color: "#3f3f46", background: "none", border: "none", cursor: "pointer", width: "100%", textAlign: "center" }}>Cancel</button>
              )}
            </div>
          </div>
        )}

        {/* ── Three-pane layout ─────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* LEFT — Inbox list */}
          <div style={{ width: 280, borderRight: "1px solid #27272a", display: "flex", flexDirection: "column", background: "#111113", flexShrink: 0 }}>

            {/* Inbox header */}
            <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid #1f1f23", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#a1a1aa", letterSpacing: "0.04em" }}>Inbox</span>
                <span style={{ fontSize: 11, color: "#27272a", fontFamily: "'Fira Code', monospace" }}>{conversations.length}</span>
              </div>

              {/* Search */}
              <div style={{ position: "relative" }}>
                <svg style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#3f3f46" strokeWidth="2.5">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search…"
                  style={{ width: "100%", boxSizing: "border-box", paddingLeft: 24, paddingRight: 8, paddingTop: 5, paddingBottom: 5, border: "1px solid #27272a", borderRadius: 6, fontSize: 12, color: "#fafaf9", background: "#18181b", outline: "none" }}
                  onFocus={e => (e.target.style.borderColor = "#22c55e")}
                  onBlur={e => (e.target.style.borderColor = "#27272a")}
                />
              </div>

              {/* Filter tabs */}
              <div style={{ display: "flex", gap: 4 }}>
                {([["all", "All"], ["needs_reply", "Reply"], ["draft_ready", "Draft"]] as [string, string][]).map(([key, label]) => (
                  <button key={key} onClick={() => setInboxFilter(key as typeof inboxFilter)} style={{
                    flex: 1, padding: "3px 4px", borderRadius: 5, fontSize: 10,
                    border: `1px solid ${inboxFilter === key ? "#22c55e" : "#27272a"}`,
                    background: inboxFilter === key ? "rgba(34,197,94,0.10)" : "transparent",
                    color: inboxFilter === key ? "#22c55e" : "#3f3f46",
                    cursor: "pointer",
                  }}>
                    {key === "all" ? `All${conversations.length > 0 ? ` (${conversations.length})` : ""}` :
                     key === "needs_reply" ? `Reply${needsReply > 0 ? ` (${needsReply})` : ""}` :
                     `Draft${draftReady > 0 ? ` (${draftReady})` : ""}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Conversation list */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {filteredConvs.length === 0 ? (
                <div style={{ padding: "40px 16px", textAlign: "center" }}>
                  <p style={{ fontSize: 14, color: "#27272a" }}>
                    {conversations.length === 0 ? "No messages yet" : "No matches"}
                  </p>
                  <p style={{ fontSize: 11, color: "#1f1f23", marginTop: 6, lineHeight: 1.5 }}>
                    {conversations.length === 0 ? "Click Demo to load sample data." : "Try a different filter"}
                  </p>
                </div>
              ) : (
                filteredConvs.map(conv => (
                  <button key={conv.id}
                    onClick={() => setSelected(conv.id === selected ? null : conv.id)}
                    style={{ width: "100%", textAlign: "left", padding: "11px 12px", background: selected === conv.id ? "#18181b" : "transparent", cursor: "pointer", display: "flex", gap: 10, alignItems: "flex-start", border: "none", borderBottom: "1px solid #1f1f23", outline: "none", transition: "background 0.1s" }}
                    onMouseEnter={e => { if (selected !== conv.id) e.currentTarget.style.background = "#18181b"; }}
                    onMouseLeave={e => { if (selected !== conv.id) e.currentTarget.style.background = "transparent"; }}
                  >
                    {/* Avatar */}
                    <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#18181b", border: "1px solid #27272a", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "#71717a" }}>{initials(conv.name)}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "#fafaf9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{conv.name}</span>
                        <span style={{ fontSize: 10, color: "#27272a", flexShrink: 0, fontFamily: "'Fira Code', monospace" }}>{fmt(conv.updatedAt)}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "#52525b", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {conv.messages[conv.messages.length - 1]?.content ?? ""}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                        <span style={{ fontSize: 10, color: STATUS_COLORS[conv.status] ?? "#27272a" }}>
                          {STATUS_LABELS[conv.status] ?? conv.status}
                        </span>
                        <TwinToggle on={conv.twinEnabled} loading={togglingTwin.has(conv.id)} onClick={e => toggleTwin(conv.id, e)} />
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* MIDDLE — Message thread */}
          {selectedConv && (
            <div style={{ width: 320, borderRight: "1px solid #27272a", display: "flex", flexDirection: "column", background: "#0d0d0f", flexShrink: 0 }}>

              {/* Thread header */}
              <div style={{ padding: "11px 14px", borderBottom: "1px solid #1f1f23", display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#18181b", border: "1px solid #27272a", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#71717a" }}>{initials(selectedConv.name)}</span>
                </div>
                <span style={{ fontSize: 14, fontWeight: 500, color: "#fafaf9", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedConv.name}</span>
                <TwinToggle on={selectedConv.twinEnabled} loading={togglingTwin.has(selectedConv.id)} onClick={e => toggleTwin(selectedConv.id, e)} />
                <button onClick={() => setSelected(null)} style={{ fontSize: 18, color: "#3f3f46", background: "none", border: "none", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#71717a")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#3f3f46")}
                >×</button>
              </div>

              {/* Messages */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                {selectedConv.messages.map((m, i) => {
                  const cur  = new Date(m.timestamp);
                  const prev = i > 0 ? new Date(selectedConv.messages[i - 1].timestamp) : null;
                  const showSep = !prev || cur.toDateString() !== prev.toDateString();
                  return (
                    <div key={i}>
                      {showSep && (
                        <div style={{ textAlign: "center", margin: "8px 0 4px" }}>
                          <span style={{ fontSize: 10, color: "#27272a", background: "#18181b", borderRadius: 10, padding: "2px 10px", fontFamily: "'Fira Code', monospace" }}>
                            {formatDay(cur)}
                          </span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: m.role === "customer" ? "flex-start" : "flex-end" }}>
                        <div dir={isArabic(m.content) ? "rtl" : "ltr"} style={{
                          maxWidth: "82%", padding: "7px 11px",
                          borderRadius: m.role === "customer" ? "2px 10px 10px 10px" : "10px 2px 10px 10px",
                          background: m.role === "customer" ? "#18181b" : "#22c55e",
                          color: m.role === "customer" ? "#fafaf9" : "#000",
                          fontSize: 12, lineHeight: 1.5,
                          border: m.role === "customer" ? "1px solid #27272a" : "none",
                        }}>
                          {m.content}
                          <div style={{ fontSize: 8, color: m.role === "customer" ? "#27272a" : "rgba(0,0,0,0.3)", marginTop: 3, fontFamily: "'Fira Code', monospace" }}>{fmt(m.timestamp)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Draft actions */}
              {selectedConv.draftReply ? (
                <div style={{ padding: "12px 12px", borderTop: "1px solid #27272a", background: "#111113" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                    <span style={{ fontSize: 10, color: "#22c55e", letterSpacing: "0.08em", fontWeight: 600 }}>AI DRAFT</span>
                    {editingDraft[selectedConv.id] === undefined && (
                      <button onClick={() => setEditingDraft(p => ({ ...p, [selectedConv.id]: selectedConv.draftReply! }))} style={{ fontSize: 10, color: "#52525b", background: "none", border: "1px solid #27272a", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>
                        Edit
                      </button>
                    )}
                  </div>
                  {editingDraft[selectedConv.id] !== undefined ? (
                    <textarea
                      value={editingDraft[selectedConv.id]}
                      onChange={e => setEditingDraft(p => ({ ...p, [selectedConv.id]: e.target.value }))}
                      dir={isArabic(editingDraft[selectedConv.id]) ? "rtl" : "ltr"}
                      rows={4}
                      style={{ width: "100%", boxSizing: "border-box", fontSize: 12, color: "#fafaf9", lineHeight: 1.5, background: "#09090b", border: "1px solid #22c55e", borderRadius: 7, padding: "8px 10px", resize: "vertical", fontFamily: "inherit", outline: "none", marginBottom: 8 }}
                    />
                  ) : (
                    <p dir={isArabic(selectedConv.draftReply) ? "rtl" : "ltr"} style={{ fontSize: 12, color: "#a1a1aa", lineHeight: 1.5, marginBottom: 10 }}>
                      {selectedConv.draftReply}
                    </p>
                  )}
                  <div style={{ display: "flex", gap: 7 }}>
                    <button onClick={() => approveDraft(selectedConv.id, editingDraft[selectedConv.id])} style={{ flex: 1, padding: "7px 0", borderRadius: 7, background: "#22c55e", color: "#000", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer" }}>
                      Approve & Send
                    </button>
                    {editingDraft[selectedConv.id] !== undefined && (
                      <button onClick={() => setEditingDraft(p => { const n = { ...p }; delete n[selectedConv.id]; return n; })} style={{ padding: "7px 10px", borderRadius: 7, background: "transparent", color: "#71717a", fontSize: 11, border: "1px solid #27272a", cursor: "pointer" }}>
                        Cancel
                      </button>
                    )}
                    <button onClick={() => regenerateDraft(selectedConv.id)} disabled={regenerating.has(selectedConv.id)} style={{ padding: "7px 10px", borderRadius: 7, background: "transparent", color: "#71717a", fontSize: 11, border: "1px solid #27272a", cursor: regenerating.has(selectedConv.id) ? "not-allowed" : "pointer", opacity: regenerating.has(selectedConv.id) ? 0.5 : 1 }}>
                      {regenerating.has(selectedConv.id) ? "Regenerating…" : "Regenerate"}
                    </button>
                    <button onClick={() => rejectDraft(selectedConv.id)} style={{ padding: "7px 10px", borderRadius: 7, background: "transparent", color: "#71717a", fontSize: 11, border: "1px solid #27272a", cursor: "pointer" }}>
                      Discard
                    </button>
                  </div>
                </div>
              ) : selectedConv.status === "needs_reply" ? (
                regenerating.has(selectedConv.id) ? (
                  <div style={{ padding: "10px 12px", borderTop: "1px solid #1f1f23", display: "flex", alignItems: "center", gap: 8, background: "#111113" }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid #27272a", borderTopColor: "#22c55e" }} className="kb-spin" />
                    <span style={{ fontSize: 11, color: "#3f3f46" }}>Generating draft…</span>
                  </div>
                ) : (
                  <div style={{ padding: "10px 12px", borderTop: "1px solid #1f1f23", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "#111113" }}>
                    <span style={{ fontSize: 11, color: "#3f3f46" }}>No draft yet</span>
                    <button onClick={() => regenerateDraft(selectedConv.id)} style={{ padding: "6px 12px", borderRadius: 7, background: "transparent", color: "#22c55e", fontSize: 11, fontWeight: 600, border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer" }}>
                      Generate draft
                    </button>
                  </div>
                )
              ) : null}
            </div>
          )}

          {/* RIGHT — AI Co-pilot */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "#09090b" }}>

            {/* AI identity header */}
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #1f1f23", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <div style={{ position: "relative", width: 22, height: 22, flexShrink: 0 }}>
                <div className="ai-pulse" style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "#22c55e" }} />
                <div style={{ position: "absolute", inset: 4, borderRadius: "50%", background: "#22c55e" }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 500, color: "#fafaf9" }}>AI Co-pilot</span>
              <span style={{ fontSize: 11, color: "#27272a", marginLeft: "auto" }}>Ask anything about your business</span>
            </div>

            {/* Messages area */}
            <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
              <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>

                {/* Empty state */}
                {ownerMsgs.length === 0 && (
                  <div style={{ textAlign: "center", paddingTop: 48 }} className="kb-fade-up">
                    <div style={{ fontSize: 22, fontWeight: 600, color: "#27272a", marginBottom: 6, letterSpacing: "-0.02em" }}>
                      Ask your business anything
                    </div>
                    <p style={{ fontSize: 13, color: "#1f1f23", marginBottom: 28 }}>
                      Search past conversations · get analytics · send messages
                    </p>

                    {overview && (overview.total_messages > 0 || overview.total_chats > 0) && (
                      <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 28 }}>
                        {[
                          { label: "Messages", value: overview.total_messages.toLocaleString() },
                          { label: "Contacts", value: overview.total_contacts.toLocaleString() },
                          { label: "Chats",    value: overview.total_chats.toLocaleString() },
                        ].map(s => (
                          <div key={s.label} style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 10, padding: "12px 18px", minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 600, color: "#22c55e", lineHeight: 1 }}>{s.value}</div>
                            <div style={{ fontSize: 10, color: "#3f3f46", marginTop: 4, letterSpacing: "0.08em", textTransform: "uppercase" }}>{s.label}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                      {[
                        "Give me an overview of all chats",
                        "Who are our most active customers?",
                        "What are the most common request types?",
                        "What did customers say about pricing?",
                        "What was my last conversation with Ahmed Benali?",
                        "What did Youssef Kadiri order?",
                      ].map(s => (
                        <button key={s} onClick={() => sendOwnerQuery(s)} style={{ fontSize: 12, color: "#52525b", background: "#111113", border: "1px solid #27272a", borderRadius: 8, padding: "7px 14px", cursor: "pointer", transition: "all 0.12s" }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = "#3f3f46"; e.currentTarget.style.color = "#a1a1aa"; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = "#27272a"; e.currentTarget.style.color = "#52525b"; }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Messages */}
                {ownerMsgs.map((msg, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }} className="kb-fade-up">
                    {msg.role === "user" ? (
                      <div dir={isArabic(msg.content) ? "rtl" : "ltr"} style={{ background: "#18181b", border: "1px solid #27272a", color: "#fafaf9", borderRadius: "14px 14px 2px 14px", padding: "10px 16px", maxWidth: 480, fontSize: 14, lineHeight: 1.55 }}>
                        {msg.content}
                      </div>
                    ) : (
                      <div style={{ background: "#111113", border: "1px solid #1f4a2e", borderLeft: "2px solid #22c55e", borderRadius: "0 14px 14px 14px", padding: "16px 20px", maxWidth: 640, width: "100%" }}>
                        {msg.streaming && !msg.content ? (
                          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} className="kb-pulse" />
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", animationDelay: "0.2s" }} className="kb-pulse" />
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", animationDelay: "0.4s" }} className="kb-pulse" />
                          </div>
                        ) : (
                          <div style={{ fontSize: 14, color: "#fafaf9", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{msg.content}</div>
                        )}
                        {msg.analyticsData && (
                          <div style={{ marginTop: 14 }}>
                            <AnalyticsCard metric={msg.analyticsData.metric} data={msg.analyticsData.data} />
                          </div>
                        )}
                        {msg.sendPreview && (
                          <div style={{ marginTop: 14, background: "#09090b", border: "1px solid #27272a", borderRadius: 10, padding: "14px 16px" }}>
                            <div style={{ fontSize: 10, color: "#3f3f46", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Send message</div>
                            <div style={{ fontSize: 13, color: "#52525b", marginBottom: 10 }}>
                              <span style={{ color: "#27272a" }}>To: </span>{msg.sendPreview.to}
                            </div>
                            <div dir={isArabic(editingPreview[i] ?? msg.sendPreview.message) ? "rtl" : "ltr"}>
                              <textarea
                                value={editingPreview[i] ?? msg.sendPreview.message}
                                onChange={e => setEditingPreview(p => ({ ...p, [i]: e.target.value }))}
                                rows={3}
                                style={{ width: "100%", boxSizing: "border-box", fontSize: 13, color: "#fafaf9", background: "#18181b", border: "1px solid #27272a", borderRadius: 7, padding: "8px 10px", resize: "vertical", fontFamily: "inherit", outline: "none", marginBottom: 10, lineHeight: 1.5 }}
                                onFocus={e => (e.target.style.borderColor = "#22c55e")}
                                onBlur={e => (e.target.style.borderColor = "#27272a")}
                              />
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button onClick={() => confirmSend(msg.sendPreview!.to, editingPreview[i] ?? msg.sendPreview!.message, i)} style={{ flex: 1, padding: "7px 0", borderRadius: 7, background: "#22c55e", color: "#000", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>
                                Send
                              </button>
                              <button onClick={() => setOwnerMsgs(prev => prev.map((m, idx) => idx === i ? { ...m, sendPreview: undefined } : m))} style={{ padding: "7px 12px", borderRadius: 7, background: "transparent", color: "#71717a", fontSize: 12, border: "1px solid #27272a", cursor: "pointer" }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            </div>

            {/* Input bar */}
            <div style={{ padding: "12px 20px", borderTop: "1px solid #1f1f23", background: "#09090b", flexShrink: 0 }}>
              <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendOwnerQuery(); } }}
                  placeholder="Ask about your customers, send a message, get analytics…"
                  disabled={streaming}
                  rows={1}
                  style={{ flex: 1, padding: "10px 14px", border: "1px solid #27272a", borderRadius: 10, fontSize: 14, color: "#fafaf9", background: "#111113", resize: "none", outline: "none", fontFamily: "inherit", lineHeight: 1.5, maxHeight: 120, overflow: "auto", transition: "border-color 0.15s" }}
                  onFocus={e => (e.target.style.borderColor = "#22c55e")}
                  onBlur={e => (e.target.style.borderColor = "#27272a")}
                />
                <button
                  onClick={() => sendOwnerQuery()}
                  disabled={!input.trim() || streaming}
                  style={{ padding: "10px 18px", borderRadius: 10, background: (input.trim() && !streaming) ? "#22c55e" : "#18181b", color: (input.trim() && !streaming) ? "#000" : "#27272a", fontSize: 13, fontWeight: 600, border: "none", cursor: (!input.trim() || streaming) ? "not-allowed" : "pointer", flexShrink: 0, transition: "all 0.15s" }}
                >
                  {streaming ? "…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}