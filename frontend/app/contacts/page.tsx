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

export default function ContactsPage() {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search,   setSearch]   = useState("");
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    const wsId = typeof window !== "undefined" ? localStorage.getItem("workspace_id") : null;
    const url  = wsId ? `/api/contacts?workspace_id=${wsId}` : null;

    const load = (u: string) =>
      apiFetch(u).then(r => r.json())
        .then(d => { setContacts(d.contacts ?? []); setLoading(false); })
        .catch(() => setLoading(false));

    if (url) {
      load(url);
    } else {
      apiFetch("/api/workspace/default")
        .then(r => r.json())
        .then(d => { localStorage.setItem("workspace_id", String(d.id)); load(`/api/contacts?workspace_id=${d.id}`); });
    }
  }, []);

  const filtered = contacts.filter(c => c.display_name.toLowerCase().includes(search.toLowerCase()));

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
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 0" }}>
              <p style={{ fontSize: 18, color: "#3f3f46" }}>
                {contacts.length === 0 ? "No contacts yet" : "No matches"}
              </p>
              {contacts.length === 0 && (
                <p style={{ fontSize: 13, color: "#27272a", marginTop: 8 }}>Upload and index a chat to see contacts appear here.</p>
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
              {filtered.map((c, i) => {
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
                      <div style={{ fontSize: 11, color: "#52525b", marginTop: 3, fontFamily: "'Fira Code', monospace" }}>
                        {c.chat_count} chat{c.chat_count !== 1 ? "s" : ""} · {c.message_count.toLocaleString()} msgs
                      </div>
                      {c.last_seen && (
                        <div style={{ fontSize: 11, color: "#3f3f46", marginTop: 2, fontFamily: "'Fira Code', monospace" }}>{relativeDate(c.last_seen)}</div>
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
        </main>
      </div>
    </div>
  );
}
