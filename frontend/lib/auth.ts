/**
 * Auth utilities.
 *
 * The JWT is stored as an httpOnly cookie set by the backend — JavaScript never
 * touches the raw token. We only keep the user info object in localStorage for
 * display purposes (username, role badge, etc.).
 */

export interface AuthUser {
  id: number;
  username: string;
  role: "owner" | "assistant" | "viewer";
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
}

// ── User info (display only, not the token) ───────────────────────────────────

const USER_KEY = "twin_user";

export function getUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function setUser(user: AuthUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser(): void {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem("workspace_id");
}

// ── Workspace ─────────────────────────────────────────────────────────────────

const WS_KEY = "workspace_id";

export function getWorkspaceId(): number {
  if (typeof window === "undefined") return 1;
  return Number(localStorage.getItem(WS_KEY) || "1");
}

export function setWorkspaceId(id: number): void {
  localStorage.setItem(WS_KEY, String(id));
}

// ── Login / logout ────────────────────────────────────────────────────────────

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/auth/login", {
    method:      "POST",
    credentials: "include",   // receive the httpOnly cookie the server sets
    headers:     { "Content-Type": "application/json" },
    body:        JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).detail || "Login failed");
  }

  const data = await res.json();
  // The token is in the httpOnly cookie — we only store user info for display
  setUser(data.user);
  return data.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", {
    method:      "POST",
    credentials: "include",
  }).catch(() => {});
  clearUser();
  window.location.href = "/login";
}

// ── apiFetch — injects workspace header, sends cookies automatically ──────────

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    "X-Workspace-ID": String(getWorkspaceId()),
  };

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: "include",   // always send the httpOnly session cookie
  });

  if (res.status === 401) {
    clearUser();
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }

  return res;
}
