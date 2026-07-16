"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getUser, setUser, apiFetch } from "@/lib/auth";

export default function ChangePasswordPage() {
  const router  = useRouter();
  const [password,  setPassword]  = useState("");
  const [confirm,   setConfirm]   = useState("");
  const [error,     setError]     = useState("");
  const [loading,   setLoading]   = useState(false);

  useEffect(() => {
    const user = getUser();
    if (!user) { router.replace("/login"); return; }
    if (!user.must_change_password) { router.replace("/agent"); }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirm) { setError("Passwords don't match"); return; }
    setLoading(true);
    try {
      const res = await apiFetch("/api/auth/change-password", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ new_password: password }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any).detail || "Failed"); }
      const user = getUser();
      if (user) setUser({ ...user, must_change_password: false });
      router.replace("/agent");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#09090b",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter', sans-serif",
    }}>
      <div style={{
        background: "#111113", border: "1px solid #27272a",
        borderRadius: 16, padding: "48px 40px", width: 360,
        boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
      }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            background: "linear-gradient(135deg, #25D366, #128C7E)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            marginBottom: 16,
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} width={22} height={22}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <div style={{ color: "#fafaf9", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
            Set your password
          </div>
          <div style={{ color: "#52525b", fontSize: 13, marginTop: 4 }}>
            Choose a new password before continuing
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", color: "#a1a1aa", fontSize: 12, marginBottom: 6, fontWeight: 500 }}>
              New password
            </label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Min. 8 characters" required autoFocus
              style={{
                width: "100%", background: "#18181b", border: "1px solid #27272a",
                borderRadius: 8, padding: "10px 14px", color: "#fafaf9",
                fontSize: 14, outline: "none", boxSizing: "border-box",
              }}
              onFocus={e => (e.target.style.borderColor = "#22c55e")}
              onBlur={e => (e.target.style.borderColor = "#27272a")}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", color: "#a1a1aa", fontSize: 12, marginBottom: 6, fontWeight: 500 }}>
              Confirm password
            </label>
            <input
              type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              placeholder="••••••••" required
              style={{
                width: "100%", background: "#18181b", border: "1px solid #27272a",
                borderRadius: 8, padding: "10px 14px", color: "#fafaf9",
                fontSize: 14, outline: "none", boxSizing: "border-box",
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
            type="submit" disabled={loading}
            style={{
              width: "100%", background: loading ? "#18181b" : "#22c55e",
              border: "none", borderRadius: 8, padding: "12px",
              color: loading ? "#52525b" : "#000",
              fontSize: 14, fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Saving…" : "Set password & continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
