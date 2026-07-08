"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { apiFetch, getUser } from "@/lib/auth";

interface User {
  id:         number;
  username:   string;
  role:       "owner" | "assistant" | "viewer";
  is_active:  boolean;
  created_at: string;
}

interface Workspace {
  id:          number;
  name:        string;
  bridge_port: number;
  phone_label: string | null;
  chat_count:  number;
  created_at:  string;
}

const ROLE_COLORS: Record<string, string> = {
  owner:     "#22c55e",
  assistant: "#3b82f6",
  viewer:    "#71717a",
};

const S = {
  card:  { background: "#111113", border: "1px solid #27272a", borderRadius: 10, padding: 20 } as React.CSSProperties,
  table: { width: "100%", borderCollapse: "collapse" as const } as React.CSSProperties,
  th:    { textAlign: "left" as const, padding: "8px 12px", fontSize: 10, color: "#3f3f46", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.08em", borderBottom: "1px solid #27272a" } as React.CSSProperties,
  td:    { padding: "12px 12px", fontSize: 13, borderBottom: "1px solid #1f1f23", color: "#a1a1aa" } as React.CSSProperties,
  label: { display: "block", fontSize: 11, color: "#71717a", marginBottom: 5, fontWeight: 500 } as React.CSSProperties,
  input: { background: "#18181b", border: "1px solid #27272a", borderRadius: 7, padding: "8px 12px", color: "#fafaf9", fontSize: 13, outline: "none", minWidth: 140 } as React.CSSProperties,
  addBtn: { background: "#22c55e", border: "none", borderRadius: 7, padding: "8px 14px", color: "#000", fontSize: 13, fontWeight: 600, cursor: "pointer" } as React.CSSProperties,
  cancelBtn: { background: "transparent", border: "1px solid #27272a", borderRadius: 7, padding: "8px 14px", color: "#71717a", fontSize: 13, cursor: "pointer" } as React.CSSProperties,
  actionBtn: { background: "transparent", border: "1px solid #27272a", borderRadius: 6, padding: "4px 10px", color: "#71717a", fontSize: 12, cursor: "pointer" } as React.CSSProperties,
  errMsg: { color: "#f87171", fontSize: 12, alignSelf: "center" } as React.CSSProperties,
};

export default function UsersPage() {
  const router     = useRouter();
  const me         = getUser();
  const numbersRef = useRef<HTMLDivElement>(null);

  const [users,      setUsers]      = useState<User[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");

  const [workspaces,   setWorkspaces]   = useState<Workspace[]>([]);
  const [wsLoading,    setWsLoading]    = useState(true);
  const [showAddWs,    setShowAddWs]    = useState(false);
  const [wsName,       setWsName]       = useState("");
  const [wsPhone,      setWsPhone]      = useState("");
  const [wsAddError,   setWsAddError]   = useState("");
  const [wsAddLoading, setWsAddLoading] = useState(false);

  const [showAdd,     setShowAdd]     = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole,     setNewRole]     = useState<"assistant" | "viewer">("assistant");
  const [addError,    setAddError]    = useState("");
  const [addLoading,  setAddLoading]  = useState(false);

  useEffect(() => {
    if (!me || me.role !== "owner") { router.replace("/agent"); return; }
    loadUsers();
    loadWorkspaces();
    if (window.location.hash === "#numbers") {
      setTimeout(() => numbersRef.current?.scrollIntoView({ behavior: "smooth" }), 300);
    }
  }, []);

  async function loadUsers() {
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/users");
      if (!res.ok) throw new Error("Failed to load users");
      setUsers(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function loadWorkspaces() {
    setWsLoading(true);
    try {
      const res = await apiFetch("/api/workspaces");
      if (res.ok) setWorkspaces(await res.json());
    } catch {}
    setWsLoading(false);
  }

  async function handleAddWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setWsAddError("");
    setWsAddLoading(true);
    try {
      const nextPort = Math.max(...workspaces.map(w => w.bridge_port), 3000) + 1;
      const res = await apiFetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: wsName, bridge_port: nextPort, phone_label: wsPhone || null }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err as any).detail || "Failed to create number"); }
      setWsName(""); setWsPhone(""); setShowAddWs(false);
      loadWorkspaces();
    } catch (e: any) { setWsAddError(e.message); }
    finally { setWsAddLoading(false); }
  }

  async function deleteWorkspace(ws: Workspace) {
    if (!confirm(`Remove number "${ws.name}"? All chats and contacts in this workspace will be deleted.`)) return;
    await apiFetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
    loadWorkspaces();
  }

  async function patchWorkspace(id: number, patch: Record<string, any>) {
    await apiFetch(`/api/workspaces/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    loadWorkspaces();
  }

  async function toggleActive(user: User) {
    await apiFetch(`/api/auth/users/${user.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_active: !user.is_active }) });
    loadUsers();
  }

  async function changeRole(user: User, role: string) {
    await apiFetch(`/api/auth/users/${user.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    loadUsers();
  }

  async function deleteUser(user: User) {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    await apiFetch(`/api/auth/users/${user.id}`, { method: "DELETE" });
    loadUsers();
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setAddError("");
    setAddLoading(true);
    try {
      const res = await apiFetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err as any).detail || "Failed to create user"); }
      setNewUsername(""); setNewPassword(""); setNewRole("assistant"); setShowAdd(false);
      loadUsers();
    } catch (e: any) { setAddError(e.message); }
    finally { setAddLoading(false); }
  }

  return (
    <div style={{ height: "100vh", display: "flex", background: "#09090b", overflow: "hidden" }}>
      <Sidebar />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top bar */}
        <div style={{ height: 52, background: "#111113", borderBottom: "1px solid #1f1f23", padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: "#fafaf9", letterSpacing: "-0.01em" }}>User Management</h1>
          <button onClick={() => setShowAdd(v => !v)} style={S.addBtn}>+ Add User</button>
        </div>

        <main style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Add user form */}
            {showAdd && (
              <div style={S.card}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.08em" }}>New user</div>
                <form onSubmit={handleAddUser} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div>
                    <label style={S.label}>Username</label>
                    <input value={newUsername} onChange={e => setNewUsername(e.target.value)} required style={S.input} placeholder="username"
                      onFocus={e => (e.target.style.borderColor = "#22c55e")} onBlur={e => (e.target.style.borderColor = "#27272a")} />
                  </div>
                  <div>
                    <label style={S.label}>Password</label>
                    <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required style={S.input} placeholder="••••••••"
                      onFocus={e => (e.target.style.borderColor = "#22c55e")} onBlur={e => (e.target.style.borderColor = "#27272a")} />
                  </div>
                  <div>
                    <label style={S.label}>Role</label>
                    <select value={newRole} onChange={e => setNewRole(e.target.value as any)} style={{ ...S.input, cursor: "pointer" }}>
                      <option value="assistant">Assistant</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </div>
                  <button type="submit" disabled={addLoading} style={S.addBtn}>{addLoading ? "Creating…" : "Create"}</button>
                  <button type="button" onClick={() => setShowAdd(false)} style={S.cancelBtn}>Cancel</button>
                  {addError && <div style={S.errMsg}>{addError}</div>}
                </form>
              </div>
            )}

            {/* Users table */}
            {loading ? (
              <div style={{ color: "#52525b", padding: 32 }}>Loading…</div>
            ) : error ? (
              <div style={{ color: "#f87171", padding: 32 }}>{error}</div>
            ) : (
              <div style={S.card}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      {["Username", "Role", "Status", "Created", "Actions"].map(h => (
                        <th key={h} style={S.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => {
                      const isMe = u.id === me?.id;
                      return (
                        <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.4 }}>
                          <td style={S.td}>
                            <span style={{ fontWeight: 600, color: "#fafaf9" }}>{u.username}</span>
                            {isMe && <span style={{ marginLeft: 8, fontSize: 11, color: "#3f3f46" }}>you</span>}
                          </td>
                          <td style={S.td}>
                            {isMe ? (
                              <span style={{ display: "inline-block", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 600, background: ROLE_COLORS[u.role] + "18", color: ROLE_COLORS[u.role] }}>
                                {u.role}
                              </span>
                            ) : (
                              <select value={u.role} onChange={e => changeRole(u, e.target.value)} style={{ background: ROLE_COLORS[u.role] + "18", color: ROLE_COLORS[u.role], border: "none", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer", outline: "none" }}>
                                <option value="owner">owner</option>
                                <option value="assistant">assistant</option>
                                <option value="viewer">viewer</option>
                              </select>
                            )}
                          </td>
                          <td style={S.td}>
                            <span style={{ fontSize: 12, color: u.is_active ? "#22c55e" : "#3f3f46", fontWeight: 600 }}>
                              {u.is_active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td style={{ ...S.td, color: "#52525b", fontSize: 12 }}>
                            {new Date(u.created_at).toLocaleDateString()}
                          </td>
                          <td style={S.td}>
                            {!isMe && (
                              <div style={{ display: "flex", gap: 8 }}>
                                <button onClick={() => toggleActive(u)} style={S.actionBtn}
                                  onMouseEnter={e => (e.currentTarget.style.color = "#fafaf9")}
                                  onMouseLeave={e => (e.currentTarget.style.color = "#71717a")}
                                >
                                  {u.is_active ? "Deactivate" : "Activate"}
                                </button>
                                <button onClick={() => deleteUser(u)} style={{ ...S.actionBtn, color: "#f87171" }}
                                  onMouseEnter={e => (e.currentTarget.style.borderColor = "#f87171")}
                                  onMouseLeave={e => (e.currentTarget.style.borderColor = "#27272a")}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Role legend */}
            <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "#3f3f46" }}>Role permissions:</span>
              <span style={{ color: ROLE_COLORS.owner }}>Owner — full access</span>
              <span style={{ color: ROLE_COLORS.assistant }}>Assistant — inbox + approve/reject</span>
              <span style={{ color: ROLE_COLORS.viewer }}>Viewer — read-only</span>
            </div>

            {/* Numbers / Workspaces */}
            <div ref={numbersRef} style={{ marginTop: 4 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#fafaf9" }}>WhatsApp Numbers</div>
                <button onClick={() => setShowAddWs(v => !v)} style={S.addBtn}>+ Add number</button>
              </div>

              {showAddWs && (
                <div style={{ ...S.card, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#52525b", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.08em" }}>New number</div>
                  <form onSubmit={handleAddWorkspace} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div>
                      <label style={S.label}>Label</label>
                      <input value={wsName} onChange={e => setWsName(e.target.value)} required placeholder="Second business" style={S.input}
                        onFocus={e => (e.target.style.borderColor = "#22c55e")} onBlur={e => (e.target.style.borderColor = "#27272a")} />
                    </div>
                    <div>
                      <label style={S.label}>Phone number (optional)</label>
                      <input value={wsPhone} onChange={e => setWsPhone(e.target.value)} placeholder="+1 234 567 8900" style={S.input}
                        onFocus={e => (e.target.style.borderColor = "#22c55e")} onBlur={e => (e.target.style.borderColor = "#27272a")} />
                    </div>
                    <button type="submit" disabled={wsAddLoading} style={S.addBtn}>{wsAddLoading ? "Adding…" : "Add"}</button>
                    <button type="button" onClick={() => setShowAddWs(false)} style={S.cancelBtn}>Cancel</button>
                    {wsAddError && <div style={S.errMsg}>{wsAddError}</div>}
                  </form>
                </div>
              )}

              <div style={S.card}>
                {wsLoading ? (
                  <div style={{ color: "#52525b", fontSize: 13 }}>Loading…</div>
                ) : (
                  <table style={S.table}>
                    <thead>
                      <tr>
                        {["Name", "Phone number", "Chats", "Actions"].map(h => (
                          <th key={h} style={S.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {workspaces.map(ws => (
                        <tr key={ws.id}>
                          <td style={S.td}>
                            <input
                              defaultValue={ws.name}
                              onBlur={e => { if (e.target.value !== ws.name) patchWorkspace(ws.id, { name: e.target.value }); }}
                              style={{ background: "transparent", border: "none", color: "#fafaf9", fontSize: 13, fontWeight: 600, outline: "none", width: 140 }}
                            />
                          </td>
                          <td style={S.td}>
                            <input
                              defaultValue={ws.phone_label ?? ""}
                              placeholder="—"
                              onBlur={e => patchWorkspace(ws.id, { phone_label: e.target.value || null })}
                              style={{ background: "transparent", border: "none", color: "#71717a", fontSize: 13, outline: "none", width: 130 }}
                            />
                          </td>
                          <td style={{ ...S.td, fontSize: 12 }}>{ws.chat_count}</td>
                          <td style={S.td}>
                            {ws.id !== 1 ? (
                              <button onClick={() => deleteWorkspace(ws)} style={{ ...S.actionBtn, color: "#f87171" }}
                                onMouseEnter={e => (e.currentTarget.style.borderColor = "#f87171")}
                                onMouseLeave={e => (e.currentTarget.style.borderColor = "#27272a")}
                              >
                                Remove
                              </button>
                            ) : (
                              <span style={{ color: "#27272a", fontSize: 12 }}>primary</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={{ color: "#3f3f46", fontSize: 12, marginTop: 8, lineHeight: 1.7 }}>
                Each number runs its own bridge process. Switch numbers using the dropdown in the sidebar.
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
