"use client";

import { useState, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import { apiFetch } from "@/lib/auth";

interface KBChat {
  job_id:            number;
  original_filename: string;
  category:          string;
  status:            string;
  message_count:     number;
  participants:      string[] | null;
  date_from:         string | null;
  date_to:           string | null;
  upload_time:       string | null;
}

interface WorkspaceData {
  workspace_id:   number;
  total_chats:    number;
  done_chats:     number;
  total_messages: number;
  chats:          KBChat[];
}

interface ActivityDay  { date: string; messages: number; }
interface TopContact   { id: number; name: string; messages: number; }

const CAT: Record<string, { text: string; bg: string; border: string; dot: string }> = {
  customer: { text: "#22c55e", bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.18)",  dot: "#22c55e" },
  team:     { text: "#3b82f6", bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.18)", dot: "#3b82f6" },
  supplier: { text: "#a78bfa", bg: "rgba(167,139,250,0.10)",border: "rgba(167,139,250,0.18)",dot: "#a78bfa" },
  other:    { text: "#71717a", bg: "rgba(113,113,122,0.10)", border: "#27272a",               dot: "#52525b" },
};

function fmtDate(d: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function fmtShort(d: string) {
  return new Date(d).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

function ActivityChart({ data }: { data: ActivityDay[] }) {
  if (data.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "32px 0", color: "#3f3f46" }}>
        <span style={{ fontSize: 14 }}>No activity data yet</span>
      </div>
    );
  }

  const max  = Math.max(...data.map(d => d.messages), 1);
  const show = data.slice(-30);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80 }}>
        {show.map(day => (
          <div
            key={day.date}
            title={`${fmtShort(day.date)}: ${day.messages} msgs`}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", cursor: "default" }}
          >
            <div style={{
              width: "100%", borderRadius: "2px 2px 0 0",
              background: "#22c55e",
              height: `${Math.max((day.messages / max) * 72, day.messages > 0 ? 3 : 0)}px`,
              opacity: 0.5, transition: "opacity 0.15s",
            }}
              onMouseEnter={e => (e.currentTarget.style.opacity = "0.9")}
              onMouseLeave={e => (e.currentTarget.style.opacity = "0.5")}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <span style={{ fontSize: 10, color: "#3f3f46", fontFamily: "'Fira Code', monospace" }}>{show.length > 0 ? fmtShort(show[0].date) : ""}</span>
        <span style={{ fontSize: 10, color: "#52525b", fontFamily: "'Fira Code', monospace" }}>{max.toLocaleString()} peak/day</span>
        <span style={{ fontSize: 10, color: "#3f3f46", fontFamily: "'Fira Code', monospace" }}>{show.length > 0 ? fmtShort(show[show.length - 1].date) : ""}</span>
      </div>
    </div>
  );
}

function TopContacts({ contacts }: { contacts: TopContact[] }) {
  const max = contacts[0]?.messages || 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {contacts.slice(0, 8).map((c, i) => (
        <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid #1f1f23" }}>
          <span style={{ fontSize: 11, color: "#3f3f46", width: 18, textAlign: "right", fontFamily: "'Fira Code', monospace" }}>{i + 1}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: "#fafaf9", marginBottom: 4 }}>{c.name}</div>
            <div style={{ height: 2, background: "#27272a", borderRadius: 1 }}>
              <div style={{ height: 2, background: "#22c55e", borderRadius: 1, width: `${(c.messages / max) * 100}%` }} />
            </div>
          </div>
          <span style={{ fontSize: 11, color: "#52525b", flexShrink: 0, fontFamily: "'Fira Code', monospace" }}>{c.messages.toLocaleString()}</span>
        </div>
      ))}
      {contacts.length === 0 && (
        <div style={{ textAlign: "center", padding: "24px 0" }}>
          <span style={{ fontSize: 14, color: "#3f3f46" }}>No contacts yet</span>
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [data,         setData]         = useState<WorkspaceData | null>(null);
  const [contactCount, setContactCount] = useState(0);
  const [filter,       setFilter]       = useState("all");
  const [loading,      setLoading]      = useState(true);
  const [activity,     setActivity]     = useState<ActivityDay[]>([]);
  const [topContacts,  setTopContacts]  = useState<TopContact[]>([]);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("workspace_id") : null;

    async function load(id: number) {
      const [wsRes, ctRes, actRes, topRes] = await Promise.all([
        apiFetch(`/api/workspaces/${id}/chats`),
        apiFetch(`/api/contacts?workspace_id=${id}`),
        apiFetch(`/api/analytics/activity?workspace_id=${id}&days=30`),
        apiFetch(`/api/analytics/top-contacts?workspace_id=${id}&limit=8`),
      ]);
      const ws  = await wsRes.json();
      const ct  = await ctRes.json();
      const act = await actRes.json();
      const top = await topRes.json();
      setData(ws);
      setContactCount(ct.total ?? 0);
      setActivity(act.data ?? []);
      setTopContacts(top.contacts ?? []);
      setLoading(false);
    }

    if (stored) {
      load(Number(stored));
    } else {
      apiFetch("/api/workspace/default")
        .then(r => r.json())
        .then(d => { localStorage.setItem("workspace_id", String(d.id)); load(d.id); });
    }
  }, []);

  const chats      = data?.chats ?? [];
  const visible    = filter === "all" ? chats : chats.filter(c => c.category === filter);
  const categories = ["all", ...Array.from(new Set(chats.map(c => c.category)))];

  return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Page top bar */}
        <div style={{ height: 52, background: "#111113", borderBottom: "1px solid #1f1f23", padding: "0 28px", display: "flex", alignItems: "center", flexShrink: 0 }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: "#fafaf9", letterSpacing: "-0.01em" }}>Dashboard</h1>
        </div>

        {loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid #27272a", borderTopColor: "#22c55e" }} className="kb-spin" />
          </div>
        ) : (
          <main style={{ flex: 1, overflowY: "auto", padding: "28px" }}>
            <div style={{ maxWidth: 1100, margin: "0 auto" }}>

              {/* Stats row */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
                {[
                  { label: "Indexed chats",  value: (data?.done_chats ?? 0).toLocaleString() },
                  { label: "Total messages", value: (data?.total_messages ?? 0).toLocaleString() },
                  { label: "Contacts",       value: contactCount.toLocaleString() },
                ].map(s => (
                  <div key={s.label} style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 12, padding: "20px 24px" }}>
                    <div style={{ fontSize: 32, fontWeight: 600, color: "#fafaf9", lineHeight: 1, letterSpacing: "-0.02em" }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: "#52525b", marginTop: 8, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 500 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Charts row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 12, marginBottom: 20 }}>
                <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 12, padding: "20px 24px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "#fafaf9" }}>Message activity</div>
                    <span style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.08em", textTransform: "uppercase" }}>Last 30 days</span>
                  </div>
                  <ActivityChart data={activity} />
                </div>

                <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 12, padding: "20px 24px" }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "#fafaf9", marginBottom: 14 }}>Top contacts</div>
                  <TopContacts contacts={topContacts} />
                </div>
              </div>

              {/* Filter bar */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
                {categories.map(cat => {
                  const active = filter === cat;
                  return (
                    <button key={cat} onClick={() => setFilter(cat)} style={{
                      padding: "5px 14px", borderRadius: 20, fontSize: 12, fontWeight: active ? 500 : 400,
                      border: `1px solid ${active ? "#22c55e" : "#27272a"}`,
                      background: active ? "rgba(34,197,94,0.12)" : "transparent",
                      color: active ? "#22c55e" : "#71717a",
                      cursor: "pointer", transition: "all 0.12s", textTransform: "capitalize",
                    }}>
                      {cat === "all" ? `All (${chats.length})` : cat}
                    </button>
                  );
                })}
              </div>

              {/* Chat grid */}
              {visible.length === 0 ? (
                <div style={{ textAlign: "center", padding: "80px 0" }}>
                  <div style={{ fontSize: 18, color: "#3f3f46", marginBottom: 10 }}>No chats indexed yet</div>
                  <p style={{ fontSize: 13, color: "#27272a" }}>Use Demo on the Inbox page to load sample data</p>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
                  {visible.map(c => {
                    const catStyle = CAT[c.category] ?? CAT.other;
                    const isDone   = c.status === "done";
                    return (
                      <div key={c.job_id} style={{
                        background: "#111113", border: `1px solid ${catStyle.border}`,
                        borderRadius: 10, padding: "16px 18px",
                        display: "flex", flexDirection: "column", gap: 8,
                        transition: "border-color 0.15s",
                      }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = catStyle.text + "44")}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = catStyle.border)}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 20,
                            background: catStyle.bg, color: catStyle.text,
                            border: `1px solid ${catStyle.border}`, textTransform: "capitalize", letterSpacing: "0.04em",
                          }}>
                            {c.category}
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: isDone ? catStyle.dot : "#f59e0b", display: "inline-block" }} />
                            <span style={{ fontSize: 11, color: "#52525b", fontFamily: "'Fira Code', monospace", textTransform: "capitalize" }}>{c.status}</span>
                          </span>
                        </div>

                        <p style={{ fontSize: 13, fontWeight: 500, color: "#fafaf9", lineHeight: 1.3 }}>
                          {c.original_filename?.replace(/\.txt$/i, "") ?? `Chat #${c.job_id}`}
                        </p>

                        <div style={{ fontSize: 11, color: "#52525b", fontFamily: "'Fira Code', monospace", display: "flex", flexDirection: "column", gap: 2 }}>
                          <span>{c.message_count.toLocaleString()} messages</span>
                          {c.participants && c.participants.length > 0 && (
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {c.participants.slice(0, 3).join(", ")}
                            </span>
                          )}
                          {(c.date_from || c.date_to) && (
                            <span>{fmtDate(c.date_from)} – {fmtDate(c.date_to)}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
