import React from "react";
import Head from "next/head";
import Link from "next/link";
import type { GetServerSideProps, NextPage } from "next";
import dynamic from "next/dynamic";
import { ThemeToggle } from "../../components/ThemeToggle";
import type { Valuation } from "../../lib/types";
import { getShare } from "../../lib/store";

// The rich read-only renderer is client-only (recharts + the app's section components).
const SharedValuationView = dynamic(() => import("../../components/SharedValuationView"), { ssr: false });

function fmtMoney(n?: number | null) {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n?.toLocaleString()}`;
}
function fmtPct(n?: number | null) {
  if (n == null || Number.isNaN(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}

const SharePage: NextPage<{ valuation: Valuation | null; origin: string }> = ({ valuation, origin }) => {
  if (!valuation) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}>
        <Head><title>Not found — DrugValue</title></Head>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24, color: "#fff" }}>DrugValue</span>
        <div className="glass" style={{ padding: "28px 32px", textAlign: "center", maxWidth: 420 }}>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 20, color: "var(--text)" }}>Valuation not found</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, fontFamily: "var(--font-mono)", marginTop: 8 }}>This link may have expired or be invalid.</p>
          <Link href="/" style={{ display: "inline-block", marginTop: 16, padding: "10px 20px", background: "var(--accent)", color: "var(--accent-fg)", borderRadius: 10, textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 13 }}>
            ← Go home
          </Link>
        </div>
      </div>
    );
  }

  const title = `${valuation.asset || valuation.name || "Valuation"} — DrugValue`;
  const description = `${valuation.asset || "Asset"}: eNPV ${fmtMoney(valuation.rnpv)}, P(approval) ${fmtPct(valuation.ptrs)}`;
  const canonical = `${origin}/share/${valuation.slug}`;

  return (
    <div style={{ minHeight: "100vh" }}>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonical} />
      </Head>

      {/* Header — glass nav over the ocean-gradient body (same look as the app) */}
      <header style={{ borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,0.15)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Link href="/" style={{ textDecoration: "none" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, color: "#fff", letterSpacing: "-0.02em" }}>DrugValue</span>
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ThemeToggle />
            <Link href="/" style={{ padding: "6px 14px", border: "1px solid var(--border-strong)", borderRadius: 10, textDecoration: "none", fontSize: 12, fontFamily: "var(--font-mono)", color: "#fff" }}>
              Build your own →
            </Link>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 24px 48px", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Asset header */}
        <div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontFamily: "var(--font-mono)", marginBottom: 4, letterSpacing: "0.08em" }}>SHARED VALUATION</div>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: 34, fontWeight: 800, color: "#fff", lineHeight: 1.1, margin: 0 }}>
            {valuation.asset || valuation.name || "Unnamed Asset"}
          </h1>
          {(valuation.indication || valuation.sponsor) && (
            <p style={{ color: "rgba(255,255,255,0.85)", fontSize: 14, marginTop: 6, fontFamily: "var(--font-mono)" }}>
              {[valuation.indication, valuation.sponsor].filter(Boolean).join(" · ")}
            </p>
          )}
          {valuation.updatedAt && (
            <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, marginTop: 4, fontFamily: "var(--font-mono)" }}>
              Updated {new Date(valuation.updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
            </p>
          )}
        </div>

        {/* Rich read-only view (metrics, assumptions, indications, charts, strategic assessment, effect
            prior, dev path, scenarios) — all from the persisted snapshot, no pipeline re-run. */}
        <SharedValuationView valuation={valuation as any} />
      </main>

      <footer style={{ borderTop: "1px solid var(--border)", marginTop: 8, background: "rgba(0,0,0,0.15)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "#fff" }}>DrugValue</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", fontFamily: "var(--font-mono)" }}>Probability-adjusted drug asset valuation</span>
        </div>
      </footer>
    </div>
  );
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { slug } = ctx.query as { slug: string };
  const slugStr = Array.isArray(slug) ? slug[0] : String(slug ?? "");
  const proto = (ctx.req.headers["x-forwarded-proto"] as string) || "http";
  const host = (ctx.req.headers["x-forwarded-host"] as string) || ctx.req.headers.host;
  const origin = `${proto}://${host}`;
  try {
    // Read the store IN-PROCESS — the SAME getShare() the /api/valuation/share route calls — instead of a
    // server-side self-fetch of that endpoint. getServerSideProps runs on the server and does NOT forward
    // the browser's gate cookie, so the old self-fetch hit the access-gate middleware and got a 401 → every
    // share 404'd, regardless of Neon. A direct read has no gate in its path, no extra hop, uses the SAME
    // slug key onShare wrote under, and works on a cold Neon instance (getShare calls ensureTable). Only the
    // shared snapshot is returned — no gated app internals — so un-gating just this read is safe by design.
    const valuation = await getShare(slugStr);
    return { props: { valuation: valuation ?? null, origin } };
  } catch (e) {
    console.error("share getServerSideProps error:", e);
    return { props: { valuation: null, origin } };
  }
};

export default SharePage;
