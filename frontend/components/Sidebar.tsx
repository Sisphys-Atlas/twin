"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getUser, logout, apiFetch, getWorkspaceId, setWorkspaceId } from "@/lib/auth";

interface Workspace {
  id:          number;
  name:        string;
  bridge_port: number;
  phone_label: string | null;
}

const ROLE_COLORS: Record<string, string> = {
  owner:     "#22c55e",
  assistant: "#3b82f6",
  viewer:    "#71717a",
};

function IconInbox({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={active ? "#fafaf9" : "#71717a"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3H10l-2-3H2"/>
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
    </svg>
  );
}

function IconDashboard({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={active ? "#fafaf9" : "#71717a"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  );
}

function IconContacts({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={active ? "#fafaf9" : "#71717a"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  );
}

function IconUsers({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={active ? "#fafaf9" : "#71717a"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

const NAV_LINKS = [
  { href: "/agent",     label: "Inbox",     Icon: IconInbox },
  { href: "/dashboard", label: "Dashboard", Icon: IconDashboard },
  { href: "/contacts",  label: "Contacts",  Icon: IconContacts },
];

export default function Sidebar() {
  const pathname = usePathname();

  // Read user/workspace from localStorage only after mount — reading it
  // synchronously during render causes a server/client hydration mismatch,
  // since localStorage doesn't exist on the server.
  const [user, setUser]             = useState<ReturnType<typeof getUser>>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWsId, setActiveWsId] = useState<number>(1);

  useEffect(() => {
    setUser(getUser());
    setActiveWsId(getWorkspaceId());
  }, []);

  useEffect(() => {
    apiFetch("/api/workspaces")
      .then(r => r.ok ? r.json() : [])
      .then((ws: Workspace[]) => {
        setWorkspaces(ws);
        if (ws.length > 0 && !ws.find(w => w.id === getWorkspaceId())) {
          handleSwitch(ws[0].id, false);
        }
      })
      .catch(() => {});
  }, []);

  function handleSwitch(id: number, reload = true) {
    setWorkspaceId(id);
    setActiveWsId(id);
    if (reload) window.location.reload();
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <aside style={{
      width: 220,
      background: "#111113",
      borderRight: "1px solid #1f1f23",
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
      height: "100vh",
    }}>

      {/* Logo */}
      <div style={{ padding: "18px 16px 14px", borderBottom: "1px solid #1f1f23" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            background: "linear-gradient(135deg, #25D366, #128C7E)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <svg viewBox="0 0 24 24" fill="white" width={13} height={13}>
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.557 4.122 1.532 5.855L.057 23.882l6.204-1.449A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.804 9.804 0 01-5.001-1.373l-.359-.214-3.722.869.936-3.422-.235-.372A9.784 9.784 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/>
            </svg>
          </div>
          <span style={{ fontSize: 15, fontWeight: 600, color: "#fafaf9", letterSpacing: "-0.01em" }}>Twin</span>
        </div>
      </div>

      {/* Workspace switcher — operators only; superadmin manages the fleet, not a number */}
      {user?.role !== "superadmin" && workspaces.length > 0 && (
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #1f1f23" }}>
          <div style={{ fontSize: 10, color: "#3f3f46", letterSpacing: "0.08em", marginBottom: 5, textTransform: "uppercase", fontWeight: 500 }}>
            Workspace
          </div>
          <select
            value={activeWsId}
            onChange={e => handleSwitch(Number(e.target.value))}
            style={{
              width: "100%", background: "#18181b", border: "1px solid #27272a",
              borderRadius: 6, color: "#a1a1aa", fontSize: 12,
              padding: "5px 8px", cursor: "pointer", outline: "none",
            }}
          >
            {workspaces.map(ws => (
              <option key={ws.id} value={ws.id} style={{ background: "#18181b" }}>
                {ws.phone_label ? `${ws.name} · ${ws.phone_label}` : ws.name}
              </option>
            ))}
          </select>
          {user?.role === "owner" && (
            <Link href="/users#numbers" style={{ display: "block", marginTop: 5, fontSize: 11, color: "#3f3f46", textDecoration: "none" }}
              onMouseEnter={e => (e.currentTarget.style.color = "#71717a")}
              onMouseLeave={e => (e.currentTarget.style.color = "#3f3f46")}
            >
              + Add number
            </Link>
          )}
        </div>
      )}

      {/* Nav links */}
      <nav style={{ flex: 1, padding: "8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {(user?.role === "superadmin" ? [] : NAV_LINKS).map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <Link key={href} href={href} style={{
              display: "flex", alignItems: "center", gap: 9,
              padding: "8px 10px", borderRadius: 7,
              background: active ? "#18181b" : "transparent",
              color: active ? "#fafaf9" : "#71717a",
              textDecoration: "none", fontSize: 13, fontWeight: active ? 500 : 400,
              transition: "all 0.12s",
            }}
              onMouseEnter={e => { if (!active) { e.currentTarget.style.background = "#18181b"; e.currentTarget.style.color = "#a1a1aa"; } }}
              onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#71717a"; } }}
            >
              <Icon active={active} />
              {label}
              {active && (
                <div style={{ marginLeft: "auto", width: 5, height: 5, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} />
              )}
            </Link>
          );
        })}

        {(user?.role === "owner" || user?.role === "superadmin") && (
          <Link href="/users" style={{
            display: "flex", alignItems: "center", gap: 9,
            padding: "8px 10px", borderRadius: 7,
            background: isActive("/users") ? "#18181b" : "transparent",
            color: isActive("/users") ? "#fafaf9" : "#71717a",
            textDecoration: "none", fontSize: 13, fontWeight: isActive("/users") ? 500 : 400,
            transition: "all 0.12s",
          }}
            onMouseEnter={e => { if (!isActive("/users")) { e.currentTarget.style.background = "#18181b"; e.currentTarget.style.color = "#a1a1aa"; } }}
            onMouseLeave={e => { if (!isActive("/users")) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#71717a"; } }}
          >
            <IconUsers active={isActive("/users")} />
            {user?.role === "superadmin" ? "Clients" : "Users"}
            {isActive("/users") && (
              <div style={{ marginLeft: "auto", width: 5, height: 5, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} />
            )}
          </Link>
        )}
      </nav>

      {/* User info */}
      {user && (
        <div style={{ padding: "12px", borderTop: "1px solid #1f1f23" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%",
              background: "#18181b", border: "1px solid #27272a",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, color: "#a1a1aa", fontWeight: 600, flexShrink: 0,
            }}>
              {user.username.slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#fafaf9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user.username}
              </div>
              <div style={{ fontSize: 10, color: ROLE_COLORS[user.role] ?? "#71717a", textTransform: "capitalize" }}>
                {user.role}
              </div>
            </div>
          </div>
          <button
            onClick={logout}
            style={{ width: "100%", padding: "6px 0", borderRadius: 6, background: "transparent", border: "1px solid #27272a", color: "#52525b", fontSize: 12, cursor: "pointer", transition: "all 0.12s" }}
            onMouseEnter={e => { e.currentTarget.style.color = "#fafaf9"; e.currentTarget.style.borderColor = "#3f3f46"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "#52525b"; e.currentTarget.style.borderColor = "#27272a"; }}
          >
            Sign out
          </button>
        </div>
      )}
    </aside>
  );
}