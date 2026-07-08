"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { apiFetch } from "@/lib/auth";

interface Appearance {
  chat_id:       number;
  chat_name:     string | null;
  category:      string | null;
  sender_name:   string | null;
  message_count: number;
}

interface RecentMessage {
  message_id: number;
  chat_id:    number;
  chat_name:  string | null;
  category:   string | null;
  timestamp:  string | null;
  body:       string | null;
  language:   string | null;
}

interface ContactProfile {
  id:               number;
  display_name:     string;
  message_count:    number;
  chat_count:       number;
  last_seen:        string | null;
  notes:            string | null;
  tags:             string[];
  appearances:      Appearance[];
  recent_messages:  RecentMessage[];
}

const PRESET_TAGS = ["VIP", "Follow-up", "Pending", "Cold", "Partner", "Blocked"];

const CAT: Record<string, { text: string; bg: string; border: string }> = {
  customer: { text: "#22c55e", bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.2)"  },
  team:     { text: "#3b82f6", bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.2)" },
  supplier: { text: "#a78bfa", bg: "rgba(167,139,250,0.10)",border: "rgba(167,139,250,0.2)"},
  other:    { text: "#71717a", bg: "rgba(113,113,122,0.10)", border: "#27272a"              },
};

function isArabic(text: string) { return /[؀-ۿ]/.test(text); }
function fmt(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

export default function ContactProfilePage() {
  const { id }   = useParams<{ id: string }>();
  const router   = useRouter();
  const [profile,      setProfile]      = useState<ContactProfile | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [notes,        setNotes]        = useState("");
  const [tags,         setTags]         = useState<string[]>([]);
  const [savingNotes,  setSavingNotes]  = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [tagInput,     setTagInput]     = useState("");

  useEffect(() => {
    apiFetch(`/api/contacts/${id}`)
      .then(r => { if (!r.ok) throw new Error("Contact not found"); return r.json(); })
      .then(d => { setProfile(d); setNotes(d.notes ?? ""); setTags(d.tags ?? []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [id]);

  async function saveNotes() {
    setSavingNotes(true);
    await apiFetch(`/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    setSavingNotes(false);
    setNotesEditing(false);
  }

  async function saveTags(next: string[]) {
    setTags(next);
    await apiFetch(`/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: next }),
    });
  }

  function toggleTag(tag: string) {
    saveTags(tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag]);
  }

  function addCustomTag() {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) saveTags([...tags, t]);
    setTagInput("");
  }

  if (loading) return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid #27272a", borderTopColor: "#22c55e" }} className="kb-spin" />
      </div>
    </div>
  );

  if (error || !profile) return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
        <p style={{ fontSize: 18, color: "#3f3f46" }}>{error ?? "Contact not found"}</p>
        <Link href="/contacts" style={{ fontSize: 13, color: "#22c55e", textDecoration: "none" }}>← Back to Contacts</Link>
      </div>
    </div>
  );

  return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div style={{ height: 52, background: "#111113", borderBottom: "1px solid #1f1f23", padding: "0 28px", display: "flex", alignItems: "center", flexShrink: 0 }}>
          <Link href="/contacts" style={{ fontSize: 12, color: "#52525b", textDecoration: "none", display: "flex", alignItems: "center", gap: 4, transition: "color 0.12s" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#a1a1aa")}
            onMouseLeave={e => (e.currentTarget.style.color = "#52525b")}
          >
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
            Contacts
          </Link>
        </div>

        <main style={{ flex: 1, overflowY: "auto", padding: "28px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>

            {/* Profile card */}
            <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 14, padding: "24px 28px", display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(34,197,94,0.10)", border: "2px solid rgba(34,197,94,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 18, fontWeight: 600, color: "#22c55e" }}>{initials(profile.display_name)}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ fontSize: 22, fontWeight: 600, color: "#fafaf9", letterSpacing: "-0.02em", lineHeight: 1 }}>{profile.display_name}</h1>
                <div style={{ fontSize: 11, color: "#3f3f46", marginTop: 8, letterSpacing: "0.08em", fontFamily: "'Fira Code', monospace" }}>
                  {profile.chat_count} CHAT{profile.chat_count !== 1 ? "S" : ""} · {profile.message_count.toLocaleString()} MESSAGES
                  {profile.last_seen ? ` · LAST SEEN ${fmt(profile.last_seen).toUpperCase()}` : ""}
                </div>
              </div>
              <button
                onClick={() => router.push(`/chat?q=${encodeURIComponent(profile.display_name)}`)}
                style={{ padding: "9px 18px", borderRadius: 8, background: "#22c55e", color: "#000", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer", flexShrink: 0 }}
              >
                Ask about this contact →
              </button>
            </div>

            {/* Tags */}
            <div>
              <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.14em", marginBottom: 10, textTransform: "uppercase", fontWeight: 600, fontFamily: "'Fira Code', monospace" }}>
                Tags
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {PRESET_TAGS.map(tag => {
                  const active = tags.includes(tag);
                  return (
                    <button key={tag} onClick={() => toggleTag(tag)} style={{
                      padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", transition: "all 0.12s",
                      border: `1px solid ${active ? "#22c55e" : "#27272a"}`,
                      background: active ? "rgba(34,197,94,0.12)" : "transparent",
                      color: active ? "#22c55e" : "#52525b",
                    }}>
                      {tag}
                    </button>
                  );
                })}
                {tags.filter(t => !PRESET_TAGS.includes(t)).map(tag => (
                  <span key={tag} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 20, fontSize: 12, background: "rgba(59,130,246,0.10)", color: "#3b82f6", border: "1px solid rgba(59,130,246,0.2)" }}>
                    {tag}
                    <button onClick={() => saveTags(tags.filter(t => t !== tag))} style={{ background: "none", border: "none", color: "#3b82f6", cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
              <form onSubmit={e => { e.preventDefault(); addCustomTag(); }} style={{ display: "flex", gap: 6 }}>
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  placeholder="Custom tag…"
                  style={{ flex: 1, fontSize: 12, padding: "6px 10px", background: "#18181b", border: "1px solid #27272a", borderRadius: 7, color: "#fafaf9", outline: "none" }}
                  onFocus={e => (e.target.style.borderColor = "#22c55e")}
                  onBlur={e => (e.target.style.borderColor = "#27272a")}
                />
                <button type="submit" style={{ padding: "6px 12px", borderRadius: 7, background: "#22c55e", color: "#000", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}>Add</button>
              </form>
            </div>

            {/* Notes */}
            <div>
              <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.14em", marginBottom: 10, textTransform: "uppercase", fontWeight: 600, fontFamily: "'Fira Code', monospace" }}>
                Notes
              </div>
              {notesEditing ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea
                    autoFocus
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    rows={4}
                    placeholder="Add a note about this contact…"
                    style={{ width: "100%", boxSizing: "border-box", fontSize: 13, color: "#fafaf9", background: "#111113", border: "1px solid #22c55e", borderRadius: 8, padding: "10px 14px", resize: "vertical", fontFamily: "inherit", outline: "none", lineHeight: 1.6 }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={saveNotes} disabled={savingNotes} style={{ padding: "7px 16px", borderRadius: 7, background: "#22c55e", color: "#000", fontSize: 12, fontWeight: 600, border: "none", cursor: savingNotes ? "not-allowed" : "pointer", opacity: savingNotes ? 0.6 : 1 }}>
                      {savingNotes ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => { setNotesEditing(false); setNotes(profile?.notes ?? ""); }} style={{ padding: "7px 12px", borderRadius: 7, background: "transparent", color: "#71717a", fontSize: 12, border: "1px solid #27272a", cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setNotesEditing(true)} style={{ width: "100%", textAlign: "left", padding: "12px 16px", borderRadius: 8, border: "1px solid #27272a", background: "#111113", fontSize: 13, color: notes ? "#a1a1aa" : "#3f3f46", cursor: "pointer", lineHeight: 1.6, fontFamily: "inherit" }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "#3f3f46")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "#27272a")}
                >
                  {notes || "Click to add a note…"}
                </button>
              )}
            </div>

            {/* Appears in */}
            <div>
              <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.14em", marginBottom: 12, textTransform: "uppercase", fontWeight: 600, fontFamily: "'Fira Code', monospace" }}>
                Appears in
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {profile.appearances.map(a => {
                  const cs = CAT[a.category ?? "other"] ?? CAT.other;
                  return (
                    <div key={a.chat_id} style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 10, padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {a.category && (
                          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: cs.bg, color: cs.text, fontFamily: "'Fira Code', monospace", textTransform: "capitalize", border: `1px solid ${cs.border}` }}>
                            {a.category}
                          </span>
                        )}
                        <span style={{ fontSize: 13, color: "#fafaf9" }}>
                          {a.chat_name?.replace(/\.txt$/i, "") ?? `Chat #${a.chat_id}`}
                        </span>
                      </div>
                      <span style={{ fontSize: 11, color: "#52525b", flexShrink: 0, fontFamily: "'Fira Code', monospace" }}>{a.message_count.toLocaleString()} msgs</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recent messages */}
            {profile.recent_messages.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.14em", marginBottom: 12, textTransform: "uppercase", fontWeight: 600, fontFamily: "'Fira Code', monospace" }}>
                  Recent messages
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {profile.recent_messages.map(m => {
                    const cs = CAT[m.category ?? "other"] ?? CAT.other;
                    return (
                      <div key={m.message_id} style={{ background: "#111113", border: "1px solid #27272a", borderLeft: "2px solid #22c55e", borderRadius: "0 10px 10px 0", padding: "12px 18px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: "#3f3f46", fontFamily: "'Fira Code', monospace" }}>{fmt(m.timestamp)}</span>
                          {m.chat_name && <span style={{ fontSize: 11, color: "#27272a", fontFamily: "'Fira Code', monospace" }}>· {m.chat_name.replace(/\.txt$/i, "")}</span>}
                          {m.category && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: cs.bg, color: cs.text, fontFamily: "'Fira Code', monospace", textTransform: "capitalize" }}>{m.category}</span>}
                        </div>
                        <p dir={isArabic(m.body ?? "") ? "rtl" : "ltr"} style={{ fontSize: 13, color: "#a1a1aa", lineHeight: 1.6, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {m.body}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
