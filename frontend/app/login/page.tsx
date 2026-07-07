"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login, getUser } from "@/lib/auth";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/agent";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    if (!getUser()) return;
    fetch("/api/auth/me", { credentials: "include" })
      .then(r => { if (r.ok) router.replace(next); })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      router.replace(next);
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#09090b",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Inter', sans-serif",
    }}>
      <div style={{
        background: "#111113",
        border: "1px solid #27272a",
        borderRadius: 16,
        padding: "48px 40px",
        width: 360,
        boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            background: "linear-gradient(135deg, #25D366, #128C7E)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            marginBottom: 16,
          }}>
            <svg viewBox="0 0 24 24" fill="white" width={22} height={22}>
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.557 4.122 1.532 5.855L.057 23.882l6.204-1.449A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.804 9.804 0 01-5.001-1.373l-.359-.214-3.722.869.936-3.422-.235-.372A9.784 9.784 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/>
            </svg>
          </div>
          <div style={{ color: "#fafaf9", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
            Twin
          </div>
          <div style={{ color: "#52525b", fontSize: 13, marginTop: 4 }}>
            Sign in to your workspace
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", color: "#a1a1aa", fontSize: 12, marginBottom: 6, fontWeight: 500 }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              required
              style={{
                width: "100%", background: "#18181b", border: "1px solid #27272a",
                borderRadius: 8, padding: "10px 14px", color: "#fafaf9",
                fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "#22c55e")}
              onBlur={e => (e.target.style.borderColor = "#27272a")}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", color: "#a1a1aa", fontSize: 12, marginBottom: 6, fontWeight: 500 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{
                width: "100%", background: "#18181b", border: "1px solid #27272a",
                borderRadius: 8, padding: "10px 14px", color: "#fafaf9",
                fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "#22c55e")}
              onBlur={e => (e.target.style.borderColor = "#27272a")}
            />
          </div>

          {error && (
            <div style={{
              background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 8, padding: "10px 14px", color: "#f87171",
              fontSize: 13, marginBottom: 16,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", background: loading ? "#18181b" : "#22c55e",
              border: "none", borderRadius: 8, padding: "12px",
              color: loading ? "#52525b" : "#000",
              fontSize: 14, fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              letterSpacing: 0.2, transition: "all 0.15s",
            }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
