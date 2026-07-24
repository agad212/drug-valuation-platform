import { useState, type FormEvent } from "react";
import Head from "next/head";
import { useRouter } from "next/router";

/**
 * Unlock page for the server-side access gate (middleware.ts).
 * The code is verified by /api/gate on the server; nothing secret ships here.
 */
export default function GatePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (r.ok) {
        const next = typeof router.query.next === "string" ? router.query.next : "/";
        const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/";
        window.location.href = safe;
        return;
      }
      const data = await r.json().catch(() => ({}));
      setError(data.error || "Wrong code — try again.");
      setCode("");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <Head>
        <title>DrugValue</title>
        <meta name="robots" content="noindex" />
      </Head>
      <form
        onSubmit={submit}
        style={{
          background: "rgba(255, 255, 255, 0.92)",
          color: "#0f2733",
          borderRadius: 12,
          padding: "32px 28px",
          width: "100%",
          maxWidth: 340,
          textAlign: "center",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.04em", marginBottom: 6 }}>DrugValue</div>
        <p style={{ fontSize: 13, opacity: 0.7, margin: "0 0 18px" }}>Enter access code</p>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError("");
          }}
          aria-label="Access code"
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontSize: 20,
            textAlign: "center",
            letterSpacing: "0.35em",
            padding: "10px 12px",
            borderRadius: 8,
            border: error ? "2px solid #d9534f" : "1px solid #b9c8cf",
            outline: "none",
            marginBottom: 12,
            background: "#ffffff",
            color: "#0f2733",
          }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            width: "100%",
            padding: "11px 0",
            borderRadius: 8,
            border: "none",
            background: "#0a6a8a",
            color: "#ffffff",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
        <div style={{ minHeight: 18, fontSize: 12, color: "#d9534f", marginTop: 8 }}>{error}</div>
      </form>
    </div>
  );
}
