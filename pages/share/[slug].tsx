import React from "react";
import Head from "next/head";
import Link from "next/link";
import type { GetServerSideProps, NextPage } from "next";
import dynamic from "next/dynamic";
import AssistantPanel from "../../components/AssistantPanel";
import { ThemeToggle } from "../../components/ThemeToggle";
import type { Valuation } from "../../lib/types";

const ValuationCharts = dynamic(() => import("../../components/ValuationCharts"), { ssr: false });

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

function MetricCard({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{
      background: accent ? "var(--accent)" : "var(--bg-card)",
      border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
      borderRadius: "var(--radius-lg)", padding: "16px 20px",
    }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: accent ? "rgba(255,255,255,0.65)" : "var(--text-faint)", fontFamily: "var(--font-display)", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-display)", color: accent ? "var(--accent-fg)" : "var(--text)" }}>{value}</div>
    </div>
  );
}

const SharePage: NextPage<{ valuation: Valuation | null; origin: string }> = ({ valuation, origin }) => {
  if (!valuation) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <Head><title>Not found — DrugValue</title></Head>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24, color: "var(--accent)" }}>DrugValue</span>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 20, color: "var(--text)" }}>Valuation not found</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, fontFamily: "var(--font-mono)" }}>This link may have expired or be invalid.</p>
        <Link href="/" style={{ padding: "10px 20px", background: "var(--accent)", color: "var(--accent-fg)", borderRadius: 10, textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 13 }}>
          ← Go home
        </Link>
      </div>
    );
  }

  const title = `${valuation.asset || valuation.name || "Valuation"} — DrugValue`;
  const description = `${valuation.asset || "Asset"}: rNPV ${fmtMoney(valuation.rnpv)}, PTRS ${fmtPct(valuation.ptrs)}`;
  const canonical = `${origin}/share/${valuation.slug}`;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonical} />
      </Head>

      <header style={{ borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--bg-card) 80%, transparent)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1300, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Link href="/" style={{ textDecoration: "none" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, color: "var(--accent)", letterSpacing: "-0.02em" }}>DrugValue</span>
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ThemeToggle />
            <Link href="/" style={{ padding: "6px 14px", border: "1px solid var(--border-strong)", borderRadius: 10, textDecoration: "none", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
              Build your own →
            </Link>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1300, margin: "0 auto", padding: 24, display: "grid", gridTemplateColumns: "1fr 360px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Asset header */}
          <div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>SHARED VALUATION</div>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 800, color: "var(--text)", lineHeight: 1.1 }}>
              {valuation.asset || valuation.name || "Unnamed Asset"}
            </h1>
            {(valuation.indication || valuation.mechanism) && (
              <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 6, fontFamily: "var(--font-mono)" }}>
                {[valuation.indication, valuation.mechanism].filter(Boolean).join(" · ")}
              </p>
            )}
            {valuation.updatedAt && (
              <p style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 4, fontFamily: "var(--font-mono)" }}>
                Updated {new Date(valuation.updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
              </p>
            )}
          </div>

          {/* Key metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
            <MetricCard label="rNPV" value={fmtMoney(valuation.rnpv)} accent />
            <MetricCard label="PTRS" value={fmtPct(valuation.ptrs)} />
            <MetricCard label="Revenue PV" value={fmtMoney(valuation.revenuePV)} />
            <MetricCard label="Dev Cost PV" value={fmtMoney(valuation.devCostPV)} />
            <MetricCard label="ROI" value={valuation.roi != null ? valuation.roi.toFixed(1) + "x" : "—"} />
          </div>

          {/* Key facts */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-faint)", marginBottom: 16 }}>Key Assumptions</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {[
                ["Phase", valuation.phase],
                ["Owner Type", valuation.ownerType],
                ["Peak Sales", fmtMoney(valuation.peakSales)],
                ["Discount Rate", fmtPct(valuation.discountRate)],
                ["Launch Year", valuation.launchYear],
                ["LOE Year", valuation.loeYear],
                ["COGS %", fmtPct(valuation.cogsPct)],
                ["Tax Rate", fmtPct(valuation.taxRate)],
              ].map(([k, val]) => (
                <div key={String(k)}>
                  <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3, fontFamily: "var(--font-mono)" }}>{k}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{val || "—"}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Charts */}
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-faint)", marginBottom: 16 }}>Analysis</div>
            <ValuationCharts valuation={valuation} />
          </div>

        </div>

        <aside>
          <AssistantPanel valuation={valuation} />
        </aside>
      </main>
    </div>
  );
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { slug } = ctx.query as { slug: string };
  const proto = (ctx.req.headers["x-forwarded-proto"] as string) || "http";
  const host = (ctx.req.headers["x-forwarded-host"] as string) || ctx.req.headers.host;
  const origin = `${proto}://${host}`;
  try {
    const res = await fetch(`${origin}/api/valuation/share/${encodeURIComponent(slug)}`);
    if (!res.ok) return { props: { valuation: null, origin } };
    const valuation = await res.json();
    return { props: { valuation, origin } };
  } catch {
    return { props: { valuation: null, origin } };
  }
};

export default SharePage;
