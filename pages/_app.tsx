import type { AppProps } from "next/app";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/router";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "../components/ThemeProvider";
import "../styles/globals.css";

const ACCESS_CODE = "5252";
const ACCESS_STORE = "dv-access";

/**
 * Soft access gate for the main site. Survey pages stay public — respondents
 * must never hit this. Unlock persists in localStorage (no expiry).
 */
function AccessGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const isPublic = router.pathname.startsWith("/survey");
  const [state, setState] = useState<"checking" | "locked" | "open">("checking");
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    if (isPublic) return;
    try {
      setState(localStorage.getItem(ACCESS_STORE) === "granted" ? "open" : "locked");
    } catch {
      setState("locked");
    }
  }, [isPublic]);

  if (isPublic) return <>{children}</>;
  if (state === "open") return <>{children}</>;
  if (state === "checking") return null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (code.trim() === ACCESS_CODE) {
      try {
        localStorage.setItem(ACCESS_STORE, "granted");
      } catch {
        /* still unlock this visit */
      }
      setState("open");
    } else {
      setWrong(true);
      setCode("");
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
            setWrong(false);
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
            border: wrong ? "2px solid #d9534f" : "1px solid #b9c8cf",
            outline: "none",
            marginBottom: 12,
            background: "#ffffff",
            color: "#0f2733",
          }}
        />
        <button
          type="submit"
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
          }}
        >
          Unlock
        </button>
        <div style={{ minHeight: 18, fontSize: 12, color: "#d9534f", marginTop: 8 }}>
          {wrong ? "Wrong code — try again." : ""}
        </div>
      </form>
    </div>
  );
}

export default function App({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  return (
    <SessionProvider session={session}>
      <ThemeProvider>
        <AccessGate>
          <Component {...pageProps} />
        </AccessGate>
      </ThemeProvider>
    </SessionProvider>
  );
}
