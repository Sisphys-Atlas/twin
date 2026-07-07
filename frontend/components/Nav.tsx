"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getUser, logout, apiFetch, getWorkspaceId, setWorkspaceId } from "@/lib/auth";

interface Workspace {
  id:          number;
  name:        string;
  bridge_port: number;
  phone_label: string | null;
}

const ROLE_COLOR: Record<string, string> = {
  owner:     "#c9a227",
  assistant: "#4a9eff",
  viewer:    "#888",
};

const LINKS = [
  { href: "/agent",     label: "Agent"     },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/contacts",  label: "Contacts"  },
];

export default function Nav() {
  const pathname = usePathname();
  const router   = useRouter();
  const user     = getUser();

  const [workspaces,  setWorkspaces]  = useState<Workspace[]>([]);
  const [activeWsId,  setActiveWsId]  = useState<number>(getWorkspaceId());

  useEffect(() => {
    apiFetch("/api/workspaces")
      .then(r => r.ok ? r.json() : [])
      .then((ws: Workspace[]) => {
        setWorkspaces(ws);
        // Ensure stored workspace_id is still valid
        if (ws.length > 0 && !ws.find(w => w.id === getWorkspaceId())) {
          handleSwitch(ws[0].id, false);
        }
      })
      .catch(() => {});
  }, []);

  function handleSwitch(id: number, reload = true) {
    setWorkspaceId(id);
    setActiveWsId(id);
    if (reload) {
      // Reload the current page so all data re-fetches for the new workspace
      window.location.reload();
    }
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  const activeWs = workspaces.find(w => w.id === activeWsId);

  return (
    <header style={{
      height: 50,
      background: "#0C0A08",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 28px",
      position: "sticky",
      top: 0,
      zIndex: 50,
      flexShrink: 0,
    }}>

      {/* Logo + workspace switcher */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg, #25D366, #128C7E)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg viewBox="0 0 24 24" fill="white" width={13} height={13}>
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.557 4.122 1.532 5.855L.057 23.882l6.204-1.449A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.804 9.804 0 01-5.001-1.373l-.359-.214-3.722.869.936-3.422-.235-.372A9.784 9.784 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/>
            </svg>
          </div>
          <span style={{ fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic", fontWeight: 400, fontSize: 17, color: "rgba(255,255,255,0.82)", letterSpacing: "0.04em" }}>
            Twin
          </span>
        </div>

        {/* Workspace / number selector */}
        {workspaces.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.08)" }} />
            <select
              value={activeWsId}
              onChange={e => handleSwitch(Number(e.target.value))}
              style={{
                background:  "transparent",
                border:      "none",
                color:       "rgba(255,255,255,0.55)",
                fontSize:    12,
                cursor:      "pointer",
                outline:     "none",
                fontFamily:  "'Outfit', sans-serif",
                maxWidth:    160,
              }}
            >
              {workspaces.map(ws => (
                <option key={ws.id} value={ws.id} style={{ background: "#1a1a1a" }}>
                  {ws.phone_label ? `${ws.name} · ${ws.phone_label}` : ws.name}
                </option>
              ))}
            </select>
            {user?.role === "owner" && (
              <Link
                href="/users#numbers"
                title="Manage numbers"
                style={{ color: "rgba(255,255,255,0.2)", fontSize: 14, lineHeight: 1, textDecoration: "none" }}
                onMouseEnter={e => (e.currentTarget.style.color = "rgba(255,255,255,0.6)")}
                onMouseLeave={e => (e.currentTarget.style.color = "rgba(255,255,255,0.2)")}
              >
                +
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Nav links */}
      <nav style={{ display: "flex", gap: 26, alignItems: "center" }}>
        {LINKS.map(({ href, label }) =>
          isActive(href) ? (
            <span key={href} style={{ fontSize: 13, fontWeight: 500, color: "#C4922A", fontFamily: "'Outfit', sans-serif" }}>
              {label}
            </span>
          ) : (
            <Link key={href} href={href} style={{ fontSize: 13, fontWeight: 400, color: "rgba(255,255,255,0.3)", textDecoration: "none", fontFamily: "'Outfit', sans-serif", transition: "color 0.15s" }}
              onMouseEnter={e => (e.currentTarget.style.color = "rgba(255,255,255,0.7)")}
              onMouseLeave={e => (e.currentTarget.style.color = "rgba(255,255,255,0.3)")}
            >
              {label}
            </Link>
          )
        )}
      </nav>

      {/* Right: user info + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {user && (
          <>
            {user.role === "owner" && (
              <Link
                href="/users"
                style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", textDecoration: "none" }}
                onMouseEnter={e => (e.currentTarget.style.color = "rgba(255,255,255,0.7)")}
                onMouseLeave={e => (e.currentTarget.style.color = "rgba(255,255,255,0.3)")}
              >
                Users
              </Link>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>{user.username}</span>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                color: ROLE_COLOR[user.role],
                background: ROLE_COLOR[user.role] + "18",
                borderRadius: 4,
                padding: "1px 6px",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}>
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              style={{
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                padding: "3px 10px",
                color: "rgba(255,255,255,0.3)",
                fontSize: 12,
                cursor: "pointer",
              }}
              onMouseEnter={e => (e.currentTarget.style.color = "rgba(255,255,255,0.7)")}
              onMouseLeave={e => (e.currentTarget.style.color = "rgba(255,255,255,0.3)")}
            >
              Sign out
            </button>
          </>
        )}
      </div>
    </header>
  );
}
