"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Link from "next/link";
import { apiFetch } from "@/lib/auth";

interface Citation {
  message_id: number;
  chat_id:    number;
  chat_name:  string | null;
  category:   string | null;
  timestamp:  string | null;
  sender:     string;
  body:       string;
  score:      number;
}

interface Message {
  role:       "user" | "assistant";
  content:    string;
  citations?: Citation[];
  streaming?: boolean;
}

const SUGGESTED = [
  { text: "What payment confirmations were received?", lang: "ltr" as const },
  { text: "ما قاله العميل عن التسعير؟",               lang: "rtl" as const },
  { text: "Résumé des négociations fournisseurs",      lang: "ltr" as const },
];

const FILTERS = [
  { value: null,       label: "All" },
  { value: "customer", label: "Customer" },
  { value: "team",     label: "Team" },
  { value: "supplier", label: "Supplier" },
];

const CAT_STYLE: Record<string, { text: string; bg: string }> = {
  customer: { text: "#22c55e", bg: "rgba(34,197,94,0.10)"  },
  team:     { text: "#3b82f6", bg: "rgba(59,130,246,0.10)" },
  supplier: { text: "#a78bfa", bg: "rgba(167,139,250,0.10)"},
  other:    { text: "#71717a", bg: "rgba(113,113,122,0.10)"},
};

function isArabic(text: string) { return /[؀-ۿ]/.test(text); }

function ChatInner() {
  const searchParams = useSearchParams();
  const [workspaceId,    setWorkspaceId]    = useState<number | null>(null);
  const [chatCount,      setChatCount]      = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [messages,       setMessages]       = useState<Message[]>([]);
  const [input,          setInput]          = useState(searchParams.get("q") ?? "");
  const [streaming,      setStreaming]      = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("workspace_id") : null;
    function init(id: number) {
      setWorkspaceId(id);
      apiFetch(`/api/workspaces/${id}/chats`).then(r => r.json()).then(d => setChatCount(d.done_chats ?? 0)).catch(() => {});
    }
    if (stored) { init(Number(stored)); }
    else { apiFetch("/api/workspace/default").then(r => r.json()).then(d => { localStorage.setItem("workspace_id", String(d.id)); init(d.id); }); }
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  useEffect(() => {
    const q = searchParams.get("q");
    if (q && workspaceId && !streaming && messages.length === 0) sendMessage(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function sendMessage(query?: string) {
    const text = (query ?? input).trim();
    if (!text || streaming || !workspaceId) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: text }, { role: "assistant", content: "", streaming: true, citations: [] }]);
    setStreaming(true);

    try {
      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text, workspace_id: workspaceId, category_filter: categoryFilter }),
      });
      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;
          try {
            const ev = JSON.parse(raw);
            if (ev.type === "chunk") {
              setMessages(prev => { const n = [...prev]; const l = n[n.length - 1]; n[n.length - 1] = { ...l, content: l.content + ev.text }; return n; });
            } else if (ev.type === "citations") {
              setMessages(prev => { const n = [...prev]; n[n.length - 1] = { ...n[n.length - 1], citations: ev.data, streaming: false }; return n; });
            } else if (ev.type === "error") {
              setMessages(prev => { const n = [...prev]; n[n.length - 1] = { ...n[n.length - 1], content: `Error: ${ev.message}`, streaming: false }; return n; });
            }
          } catch { /* skip */ }
        }
      }
    } catch {
      setMessages(prev => { const n = [...prev]; n[n.length - 1] = { ...n[n.length - 1], content: "Could not reach the backend.", streaming: false }; return n; });
    } finally {
      setStreaming(false);
      setMessages(prev => { const n = [...prev]; if (n[n.length - 1]?.streaming) n[n.length - 1] = { ...n[n.length - 1], streaming: false }; return n; });
      inputRef.current?.focus();
    }
  }

  const hasChats = chatCount > 0;

  return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Filter bar */}
        <div style={{ height: 48, background: "#111113", borderBottom: "1px solid #1f1f23", padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: "#3f3f46", fontFamily: "'Fira Code', monospace" }}>
            {chatCount} chat{chatCount !== 1 ? "s" : ""} indexed
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {FILTERS.map(f => {
              const active = categoryFilter === f.value;
              return (
                <button key={String(f.value)} onClick={() => setCategoryFilter(f.value)} style={{
                  padding: "3px 12px", borderRadius: 20, fontSize: 11,
                  border: `1px solid ${active ? "#22c55e" : "#27272a"}`,
                  background: active ? "rgba(34,197,94,0.12)" : "transparent",
                  color: active ? "#22c55e" : "#52525b", cursor: "pointer", transition: "all 0.12s",
                }}>
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "28px 24px" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

            {messages.length === 0 && (
              <div style={{ textAlign: "center", paddingTop: 80 }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: "#27272a", marginBottom: 8, letterSpacing: "-0.02em" }}>
                  {hasChats ? "Ask anything" : "No chats yet"}
                </div>
                <p style={{ fontSize: 13, color: "#3f3f46" }}>
                  {hasChats ? "Search across all indexed conversations · Arabic · French · English"
                    : <><Link href="/" style={{ color: "#22c55e", textDecoration: "none" }}>Upload a chat export</Link> to get started</>}
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }} className="kb-fade-up">
                {msg.role === "user" ? (
                  <div dir={isArabic(msg.content) ? "rtl" : "ltr"} style={{ background: "#18181b", border: "1px solid #27272a", color: "#fafaf9", borderRadius: "14px 14px 2px 14px", padding: "10px 16px", maxWidth: 520, fontSize: 14, lineHeight: 1.55 }}>
                    {msg.content}
                  </div>
                ) : (
                  <div style={{ background: "#111113", border: "1px solid #1f4a2e", borderLeft: "2px solid #22c55e", borderRadius: "0 14px 14px 14px", padding: "16px 20px", maxWidth: 680, width: "100%" }}>
                    <p dir={isArabic(msg.content) ? "rtl" : "ltr"} style={{ fontSize: 14, color: "#fafaf9", whiteSpace: "pre-wrap", lineHeight: 1.65 }}>
                      {msg.content}
                      {msg.streaming && <span style={{ display: "inline-block", width: 2, height: 14, background: "#22c55e", marginLeft: 2, verticalAlign: "text-bottom" }} className="kb-pulse" />}
                    </p>

                    {!msg.streaming && msg.citations && msg.citations.length > 0 && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid #1f1f23" }}>
                        <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.12em", marginBottom: 10, textTransform: "uppercase", fontFamily: "'Fira Code', monospace" }}>Sources</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {msg.citations.map((c, j) => {
                            const cs = CAT_STYLE[c.category ?? "other"] ?? CAT_STYLE.other;
                            return (
                              <div key={j} style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                                <div style={{ flexShrink: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 500, color: "#fafaf9" }}>{c.sender}</div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                                    <span style={{ fontSize: 10, color: "#3f3f46", fontFamily: "'Fira Code', monospace" }}>{c.timestamp?.slice(0, 10) ?? ""}</span>
                                    {c.chat_name && <span style={{ fontSize: 10, color: "#27272a", fontFamily: "'Fira Code', monospace" }}>· {c.chat_name.replace(/\.txt$/i, "")}</span>}
                                    {c.category && <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: cs.bg, color: cs.text, fontFamily: "'Fira Code', monospace", textTransform: "capitalize" }}>{c.category}</span>}
                                  </div>
                                </div>
                                <p dir={isArabic(c.body) ? "rtl" : "ltr"} style={{ fontSize: 12, color: "#71717a", lineHeight: 1.5, flex: 1, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                                  {c.body}
                                </p>
                              </div>
                            );
                          })}
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

        {/* Input */}
        <div style={{ background: "#111113", borderTop: "1px solid #1f1f23", padding: "14px 24px", flexShrink: 0 }}>
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            {messages.length === 0 && hasChats && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {SUGGESTED.map(s => (
                  <button key={s.text} dir={s.lang} onClick={() => sendMessage(s.text)} disabled={streaming} style={{ fontSize: 12, color: "#52525b", background: "#18181b", border: "1px solid #27272a", borderRadius: 8, padding: "6px 12px", cursor: streaming ? "not-allowed" : "pointer", opacity: streaming ? 0.4 : 1, transition: "all 0.12s" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "#3f3f46"; e.currentTarget.style.color = "#a1a1aa"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "#27272a"; e.currentTarget.style.color = "#52525b"; }}
                  >
                    {s.text}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={e => { e.preventDefault(); sendMessage(); }} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                dir={isArabic(input) ? "rtl" : "ltr"}
                placeholder={hasChats ? "Ask anything across all your conversations…" : "Upload a chat first…"}
                disabled={streaming || !hasChats}
                rows={1}
                style={{ flex: 1, background: "#18181b", border: "1px solid #27272a", borderRadius: 10, padding: "11px 16px", fontSize: 14, color: "#fafaf9", outline: "none", resize: "none", fontFamily: "inherit", lineHeight: 1.5, transition: "border-color 0.15s", opacity: !hasChats ? 0.4 : 1 }}
                onFocus={e => (e.target.style.borderColor = "#22c55e")}
                onBlur={e => (e.target.style.borderColor = "#27272a")}
              />
              <button type="submit" disabled={!input.trim() || streaming || !hasChats} style={{ width: 42, height: 42, borderRadius: 10, background: input.trim() && !streaming && hasChats ? "#22c55e" : "#27272a", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: input.trim() && !streaming && hasChats ? "pointer" : "not-allowed", transition: "background 0.15s", flexShrink: 0 }}>
                {streaming ? (
                  <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid #3f3f46", borderTopColor: "#22c55e" }} className="kb-spin" />
                ) : (
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={input.trim() && hasChats ? "#000" : "#52525b"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  return <Suspense><ChatInner /></Suspense>;
}
