"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { apiFetch } from "@/lib/auth";

interface Contact {
  id:            number;
  display_name:  string;
  message_count: number;
  chat_count:    number;
  last_seen:     string | null;
  tags:          string[];
}

interface AvailableChat {
  phone:       string;
  name:        string;
  isGroup:     boolean;
  lastMessage: string | null;
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

function relativeDate(iso: string | null) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30)  return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const AVATAR_COLORS = [
  { bg: "rgba(34,197,94,0.12)",   text: "#22c55e" },
  { bg: "rgba(59,130,246,0.12)",  text: "#3b82f6" },
  { bg: "rgba(167,139,250,0.12)", text: "#a78bfa" },
  { bg: "rgba(251,146,60,0.12)",  text: "#fb923c" },
  { bg: "rgba(244,114,182,0.12)", text: "#f472b6" },
  { bg: "rgba(234,179,8,0.12)",   text: "#eab308" },
];

const PRESET_TAGS = ["VIP", "Follow-up", "Pending", "Cold", "Partner", "Blocked"];

export default function ContactsPage() {
  const router = useRouter();
  const [contacts,  setContacts]  = useState<Contact[]>([]);
  const [available, setAvailable] = useState<AvailableChat[]>([]);
  const [search,    setSearch]    = useState("");
  const [loading,   setLoading]   = useState(true);
  const [adding,    setAdding]    = useState<Set<string>>(new Set());
  const [addError,  setAddError]  = useState<Record<string, string>>({});
  const [fixing,    setFixing]    = useState(false);
  const [fixMsg,    setFixMsg]    = useState("");

  function load() {
    apiFetch("/api/whatsapp/contacts/all")
      .then(r => r.json())
      .then(d => {
        setContacts(d.imported ?? []);
        setAvailable(d.available ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function addToChat(phone: string) {
    if (adding.has(phone)) return;
    setAdding(prev => new Set(prev).add(phone));
    setAddError(prev => { const n = { ...prev }; delete n[phone]; return n; });
    try {
      const r = await apiFetch("/api/whatsapp/sync/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, category: "other" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any).detail || "Import failed");
      }
      load(); // moves this contact from "available" to "imported"
    } catch (e: any) {
      setAddError(prev => ({ ...prev, [phone]: e.message }));
    } finally {
      setAdding(prev => { const n = new Set(prev); n.delete(phone); return n; });
    }
  }

  async function fixStaleImportStatus() {
    if (fixing) return;
    setFixing(true);
    setFixMsg("");
    try {
      const r = await apiFetch("/api/whatsapp/sync/backfill-phones", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error((d as any).detail || "Failed");
      setFixMsg(`Matched ${d.matched} of ${d.chats_checked} chat(s)`);
      load();
    } catch (e: any) {
      setFixMsg(e.message);
    } finally {
      setFixing(false);
    }
  }

  const filteredContacts  = contacts.filter(c => c.display_name.toLowerCase().includes(search.toLowerCase()));
  const filteredAvailable = available.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div style={{ height: 52, background: "#111113", borderBottom: "1px solid #1f1f23", padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ fontSize: 16, fontWeight: 600, color: "#fafaf9", letterSpacing: "-0.01em" }}>Contacts</h1>
            <span style={{ fontSize: 12, color: "#3f3f46", fontFamily: "'Fira Code', monospace" }}>
              {contacts.length}
            </span>
          </div>

          {/* Search */}
          <div style={{ position: "relative" }}>
            <svg style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search contacts…"
              style={{
                paddingLeft: 30, paddingRight: 14, paddingTop: 7, paddingBottom: 7,
                borderRadius: 8, border: "1px solid #27272a", background: "#18181b",
                fontSize: 13, color: "#fafaf9", outline: "none", width: 220, transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "#22c55e")}
              onBlur={e => (e.target.style.borderColor = "#27272a")}
            />
          </div>
        </div>

        <main style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          {loading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid #27272a", borderTopColor: "#22c55e" }} className="kb-spin" />
            </div>
          ) : (
            <>
              {filteredContacts.length === 0 && filteredAvailable.length === 0 ? (
                <div style={{ textAlign: "center", padding: "80px 0" }}>
                  <p style={{ fontSize: 18, color: "#3f3f46" }}>
                    {contacts.length === 0 && available.length === 0 ? "No contacts yet" : "No matches"}
                  </p>
                  {contacts.length === 0 && available.length === 0 && (
                    <p style={{ fontSize: 13, color: "#27272a", marginTop: 8 }}>Connect WhatsApp and import a chat to see contacts appear here.</p>
                  )}
                </div>
              ) : (
                <>
                  {filteredContacts.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10, marginBottom: filteredAvailable.length > 0 ? 28 : 0 }}>
                      {filteredContacts.map((c, i) => {
                        const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
                        return (
                          <button key={c.id} onClick={() => router.push(`/contacts/${c.id}`)} style={{
                            background: "#111113", border: "1px solid #27272a", borderRadius: 10,
                            padding: "14px 16px", textAlign: "left",
                            display: "flex", alignItems: "center", gap: 12,
                            cursor: "pointer", transition: "all 0.12s",
                          }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = "#3f3f46"; e.currentTarget.style.background = "#18181b"; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = "#27272a"; e.currentTarget.style.background = "#111113"; }}
                          >
                            <div style={{
                              width: 40, height: 40, borderRadius: "50%",
                              background: color.bg, border: `1px solid ${color.text}22`,
                              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                            }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: color.text }}>{initials(c.display_name)}</span>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: "#fafaf9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.display_name}</div>
                              {c.tags && c.tags.length > 0 ? (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                                  {c.tags.map(tag => {
                                    const preset = PRESET_TAGS.includes(tag);
                                    return (
                                      <span key={tag} style={{
                                        fontSize: 10, padding: "2px 8px", borderRadius: 20,
                                        background: preset ? "rgba(34,197,94,0.12)" : "rgba(59,130,246,0.10)",
                                        color: preset ? "#22c55e" : "#3b82f6",
                                        border: `1px solid ${preset ? "rgba(34,197,94,0.25)" : "rgba(59,130,246,0.2)"}`,
                                      }}>
                                        {tag}
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div style={{ fontSize: 11, color: "#52525b", marginTop: 3, fontFamily: "'Fira Code', monospace" }}>
                                  {c.chat_count} chat{c.chat_count !== 1 ? "s" : ""} · {c.message_count.toLocaleString()} msgs
                                </div>
                              )}
                              {c.last_seen && (
                                <div style={{ fontSize: 11, color: "#3f3f46", marginTop: 3, fontFamily: "'Fira Code', monospace" }}>{relativeDate(c.last_seen)}</div>
                              )}
                            </div>
                            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#27272a" strokeWidth="2">
                              <path d="M9 18l6-6-6-6"/>
                            </svg>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {filteredAvailable.length > 0 && (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600 }}>
                          Not imported yet ({filteredAvailable.length})
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {fixMsg && <span style={{ fontSize: 11, color: "#52525b" }}>{fixMsg}</span>}
                          <button onClick={fixStaleImportStatus} disabled={fixing} style={{ fontSize: 11, color: "#52525b", background: "none", border: "1px solid #27272a", borderRadius: 6, padding: "3px 10px", cursor: fixing ? "not-allowed" : "pointer" }}>
                            {fixing ? "Checking…" : "Seeing an already-imported contact here? Fix"}
                          </button>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
                        {filteredAvailable.map((c, i) => (
                          <div key={c.phone} style={{
                            background: "#0d0d0f", border: "1px solid #1f1f23", borderRadius: 10,
                            padding: "14px 16px", display: "flex", alignItems: "center", gap: 12,
                          }}>
                            <div style={{
                              width: 40, height: 40, borderRadius: "50%",
                              background: "#18181b", border: "1px solid #27272a",
                              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                            }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "#52525b" }}>{initials(c.name)}</span>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: "#a1a1aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {c.name} {c.isGroup && <span style={{ color: "#3f3f46", fontSize: 10 }}>· group</span>}
                              </div>
                              {c.lastMessage && (
                                <div style={{ fontSize: 11, color: "#3f3f46", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.lastMessage}</div>
                              )}
                              {addError[c.phone] && (
                                <div style={{ fontSize: 10, color: "#f87171", marginTop: 3 }}>{addError[c.phone]}</div>
                              )}
                            </div>
                            <button
                              onClick={() => addToChat(c.phone)}
                              disabled={adding.has(c.phone)}
                              style={{
                                padding: "6px 12px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                                background: adding.has(c.phone) ? "#18181b" : "transparent",
                                color: adding.has(c.phone) ? "#52525b" : "#22c55e",
                                border: `1px solid ${adding.has(c.phone) ? "#27272a" : "rgba(34,197,94,0.3)"}`,
                                cursor: adding.has(c.phone) ? "not-allowed" : "pointer",
                                whiteSpace: "nowrap", flexShrink: 0,
                              }}
                            >
                              {adding.has(c.phone) ? "Adding…" : "Add to chat"}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}