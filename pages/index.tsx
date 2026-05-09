import React, { useEffect, useMemo, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import dynamic from "next/dynamic";
import { signIn, signOut, useSession } from "next-auth/react";
import { ThemeToggle } from "../components/ThemeToggle";
import AssistantPanel from "../components/AssistantPanel";
import { useToast } from "../components/Toast";
import type { Valuation, Indication, RevenueAnalysisResult, IndicationRevenueAnalysis } from "../lib/types";
import { computeOutputs, computeRevenuePV } from "../lib/cashflow";
import type { CtgovTrial } from "../lib/ctgov";

const ValuationCharts = dynamic(() => import("../components/ValuationCharts"), { ssr: false });

const DEFAULT_VALUATION: Valuation = {
  asset: "",
  indication: "",
  mechanism: "",
  phase: "",
  discountRate: 0.12,
  cogsPct: 0.2,
  taxRate: 0.21,
  workingCapitalPct: 0.1,
  avgRoyalty: 0.15,
};

function fmtMoney(n?: number | null) {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) > 0) return `~$0`;
  return `$${n.toLocaleString()}`;
}
// Per-patient annual price (e.g. 150000 = $150K/yr, not $0.0M)
function fmtPrice(n?: number | null) {
  if (n == null || Number.isNaN(n) || n === 0) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtPct(n?: number | null, dp = 1) {
  if (n == null || Number.isNaN(n)) return "—";
  return (n * 100).toFixed(dp) + "%";
}

const STORAGE_KEY = "drugvalue/savedValuations";
function loadAll(): Record<string, Valuation> {
  if (typeof window === "undefined") return {};
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function saveAll(map: Record<string, Valuation>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}
function cryptoId() {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const arr = new Uint32Array(1); crypto.getRandomValues(arr); return arr[0].toString(36);
  }
  return Math.random().toString(36).slice(2);
}
function randomSlug() { return Math.random().toString(36).slice(2, 8); }

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: "0.12em",
      color: "var(--text-faint)", marginBottom: 12,
    }}>{children}</div>
  );
}

function FieldInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>{label}</div>
      <input className="input-base" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function FieldSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, fontFamily: "var(--font-mono)" }}>{label}</div>
      <select className="input-base" value={value} onChange={(e) => onChange(e.target.value)} style={{ cursor: "pointer" }}>
        {options.map((o) => <option key={o} value={o}>{o === "" ? "—" : o}</option>)}
      </select>
    </label>
  );
}

function FieldNumber({ label, value, onChange, isPct, integer, hint }: {
  label: string; value?: number; onChange: (v: number) => void;
  isPct?: boolean; integer?: boolean; hint?: string;
}) {
  const [txt, setTxt] = useState(value != null ? String(isPct ? +(value * 100).toFixed(4) : value) : "");
  useEffect(() => { setTxt(value != null ? String(isPct ? +(value * 100).toFixed(4) : value) : ""); }, [value, isPct]);
  function commit(s: string) {
    const n = Number(s);
    if (Number.isNaN(n)) return;
    if (isPct) onChange(Math.max(0, Math.min(1, n / 100)));
    else onChange(integer ? Math.round(n) : n);
  }
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, fontFamily: "var(--font-mono)", display: "flex", justifyContent: "space-between" }}>
        <span>{label}</span>
        {hint && <span style={{ color: "var(--text-faint)" }}>{hint}</span>}
      </div>
      <input type="number" step={integer ? 1 : 0.01} className="input-base"
        value={txt} onChange={(e) => setTxt(e.target.value)}
        onBlur={() => commit(txt)} onKeyDown={(e) => { if (e.key === "Enter") commit(txt); }} />
    </label>
  );
}

function MetricCard({ label, value, sub, gradient }: { label: string; value: React.ReactNode; sub?: string; gradient?: string }) {
  return (
    <div className="animate-fade-up" style={{
      background: gradient || "var(--bg-card)",
      backdropFilter: gradient ? undefined : "blur(20px)",
      WebkitBackdropFilter: gradient ? undefined : "blur(20px)",
      border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: "var(--radius-lg)", padding: "16px 20px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
    }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(255,255,255,0.7)", fontFamily: "var(--font-display)", fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-display)", color: "#ffffff", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "var(--bg-card-solid)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      border: "1px solid var(--border-strong)",
      borderRadius: "var(--radius-lg)", padding: 24,
      boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
      color: "var(--text)",
      ...style
    }}>
      {children}
    </div>
  );
}

// ─── P&L Table ───────────────────────────────────────────────────────────────
function PnLTable({ v, out, onClose }: { v: Valuation; out: ReturnType<typeof computeOutputs>; onClose: () => void }) {
  const [distPct, setDistPct] = useState(v.distributionPct ?? 0.05);
  const [opexPct, setOpexPct] = useState(v.commercialOpexPct ?? 0.20);

  const now = new Date().getFullYear();
  const disc = v.discountRate ?? 0.12;
  const cogs = v.cogsPct ?? 0.2;
  const tax = v.taxRate ?? 0.21;
  const ptrs = out.ptrs;
  const isLicensor = v.ownerType === "Licensor";
  const royalty = v.avgRoyalty ?? 0.15;

  const inds = (v.indications && v.indications.length > 0) ? v.indications : [{
    id: "s", name: v.indication || v.asset || "Asset",
    peakSales: v.peakSales, launchYear: v.launchYear, loeYear: v.loeYear,
    ptrs: v.ptrs, devCostPV: v.devCostPV,
  }];

  const minLaunch = Math.min(...inds.map(i => i.launchYear ?? v.launchYear ?? now + 3));
  const maxLoe = Math.max(...inds.map(i => i.loeYear ?? v.loeYear ?? now + 13));
  const devYears: number[] = [];
  for (let y = now; y < minLaunch; y++) devYears.push(y);
  if (devYears.length === 0) devYears.push(now);

  // Spread nominal dev cost evenly over dev years
  const totalDevCostNominal = (v.devCostPV ?? 0) * (1 + disc); // rough nominal est.
  const annualDevCost = totalDevCostNominal / Math.max(1, devYears.length);

  const ramps: Record<number, number> = { 0: 0.2, 1: 0.5, 2: 0.8, 3: 1.0 };

  type Row = {
    year: number; isLaunch: boolean; isDevPhase: boolean;
    ptrsEff: number; df: number;
    grossRevenue: number; cogsAmt: number; distAmt: number; opexAmt: number;
    netRevenue: number; netIncome: number;
    pwGrossRevenue: number; pwNetIncome: number; dcf: number;
    rdCost: number; pwRdCost: number;
    cumExpCosts: number; cumDcf: number; eNPV: number; pi: number;
  };

  const rows: Row[] = [];
  let cumExpCosts = 0;
  let cumDcf = 0;

  // Dev phase rows
  devYears.forEach((yr) => {
    const t = yr - now;
    const df = 1 / Math.pow(1 + disc, Math.max(0, t));
    const pwRdCost = annualDevCost * ptrs;
    const dcf = -pwRdCost * df;
    cumExpCosts += pwRdCost;
    cumDcf += dcf;
    rows.push({
      year: yr, isLaunch: false, isDevPhase: true,
      ptrsEff: ptrs, df,
      grossRevenue: 0, cogsAmt: 0, distAmt: 0, opexAmt: 0,
      netRevenue: 0, netIncome: 0,
      pwGrossRevenue: 0, pwNetIncome: 0, dcf,
      rdCost: annualDevCost, pwRdCost,
      cumExpCosts, cumDcf, eNPV: cumDcf,
      pi: cumExpCosts > 0 ? cumDcf / cumExpCosts : 0,
    });
  });

  // Commercial phase rows
  for (let yr = minLaunch; yr <= maxLoe + 1; yr++) {
    const t = yr - now;
    const df = 1 / Math.pow(1 + disc, Math.max(0, t));
    let grossRevenue = 0;
    const isLaunch = yr === minLaunch;

    inds.forEach((ind) => {
      const ly = ind.launchYear ?? v.launchYear ?? minLaunch;
      const loe = ind.loeYear ?? v.loeYear ?? maxLoe;
      const ps = ind.peakSales ?? v.peakSales ?? 0;
      if (yr < ly || yr > loe + 1) return;
      const i = yr - ly;
      const pct = i <= 3 ? (ramps[i] ?? 1) : (yr <= loe ? 1 : 0.5);
      grossRevenue += ps * pct;
    });

    if (grossRevenue === 0) continue;

    const cogsAmt = isLicensor ? 0 : grossRevenue * cogs;
    const distAmt = isLicensor ? 0 : grossRevenue * distPct;
    const opexAmt = isLicensor ? 0 : grossRevenue * opexPct;
    const netRevenue = isLicensor ? grossRevenue * royalty : grossRevenue - cogsAmt - distAmt - opexAmt;
    const netIncome = isLicensor ? netRevenue : netRevenue * (1 - tax);

    const pwGrossRevenue = grossRevenue * ptrs;
    const pwNetIncome = netIncome * ptrs;
    const dcf = pwNetIncome * df;
    cumDcf += dcf;

    rows.push({
      year: yr, isLaunch, isDevPhase: false,
      ptrsEff: ptrs, df,
      grossRevenue, cogsAmt, distAmt, opexAmt,
      netRevenue, netIncome,
      pwGrossRevenue, pwNetIncome, dcf,
      rdCost: 0, pwRdCost: 0,
      cumExpCosts, cumDcf, eNPV: cumDcf,
      pi: cumExpCosts > 0 ? cumDcf / cumExpCosts : 0,
    });
  }

  const finalENPV = rows[rows.length - 1]?.eNPV ?? 0;
  const finalPI = rows[rows.length - 1]?.pi ?? 0;

  const th = (label: string) => (
    <th style={{ padding: "5px 8px", textAlign: "right", color: "var(--text-faint)", fontWeight: 600, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap", borderBottom: "2px solid var(--border)" }}>{label}</th>
  );
  const td = (val: React.ReactNode, opts?: { bold?: boolean; color?: string; left?: boolean }) => (
    <td style={{ padding: "4px 8px", textAlign: opts?.left ? "left" : "right", fontWeight: opts?.bold ? 700 : 400, color: opts?.color || "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap", borderBottom: "1px solid var(--border)" }}>{val}</td>
  );

  return (
    <>
      {/* Assumptions bar */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16, padding: "12px 16px", background: "rgba(16,185,129,0.06)", borderRadius: 10, border: "1px solid rgba(16,185,129,0.15)", fontSize: 12 }}>
        <div>
          <span style={{ color: "var(--text-faint)", marginRight: 6 }}>Discount Rate:</span>
          <strong style={{ color: "var(--text)" }}>{fmtPct(disc)}</strong>
          <span style={{ color: "var(--text-faint)", marginLeft: 6, fontSize: 11 }}>— WACC / pharma industry benchmark ({v.phase === "Approved" ? "lower risk, approved asset" : v.phase === "Phase 3" ? "moderate risk, late-stage" : "high risk, early-stage"})</span>
        </div>
        <div>
          <span style={{ color: "var(--text-faint)", marginRight: 6 }}>PTRS:</span>
          <strong style={{ color: "var(--text)" }}>{fmtPct(ptrs)}</strong>
          <span style={{ color: "var(--text-faint)", marginLeft: 6, fontSize: 11 }}>— {out.mechLabel}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--text-faint)" }}>Distribution %:</span>
          <input type="number" step={0.1} value={+(distPct * 100).toFixed(1)}
            onChange={e => setDistPct(Math.max(0, Math.min(1, Number(e.target.value) / 100)))}
            style={{ width: 50, fontSize: 11, padding: "2px 4px", background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontFamily: "var(--font-mono)" }} />
          <span style={{ color: "var(--text-faint)" }}>%</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--text-faint)" }}>Commercial OPEX %:</span>
          <input type="number" step={1} value={+(opexPct * 100).toFixed(0)}
            onChange={e => setOpexPct(Math.max(0, Math.min(1, Number(e.target.value) / 100)))}
            style={{ width: 50, fontSize: 11, padding: "2px 4px", background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontFamily: "var(--font-mono)" }} />
          <span style={{ color: "var(--text-faint)" }}>%</span>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              {th("Year")}
              {th("Launch")}
              {th("PTRS")}
              {th("Disc. Factor")}
              {th("PW R&D Costs")}
              {th("PW Gross Revenue")}
              {th("COGS")}
              {th("Distribution")}
              {th("Comm. OPEX")}
              {th("Net Revenue")}
              {th("Net Income")}
              {th("DCF")}
              {th("Exp. Costs")}
              {th("Total Exp. Costs")}
              {th("eNPV")}
              {th("PI")}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.year} style={{ background: r.isLaunch ? "rgba(16,185,129,0.05)" : r.isDevPhase ? "rgba(239,68,68,0.03)" : undefined }}>
                {td(<strong style={{ color: "var(--text)" }}>{r.year}</strong>)}
                {td(r.isLaunch ? "🚀" : r.isDevPhase ? "R&D" : "—", { color: r.isLaunch ? "var(--accent)" : "var(--text-faint)" })}
                {td(fmtPct(r.ptrsEff, 0))}
                {td(r.df.toFixed(3))}
                {td(r.pwRdCost > 0 ? `(${fmtMoney(r.pwRdCost)})` : "—", { color: r.pwRdCost > 0 ? "var(--danger)" : "var(--text-faint)" })}
                {td(r.pwGrossRevenue > 0 ? fmtMoney(r.pwGrossRevenue) : "—")}
                {td(r.cogsAmt > 0 ? `(${fmtMoney(r.cogsAmt * r.ptrsEff)})` : "—", { color: "var(--danger)" })}
                {td(r.distAmt > 0 ? `(${fmtMoney(r.distAmt * r.ptrsEff)})` : "—", { color: "var(--danger)" })}
                {td(r.opexAmt > 0 ? `(${fmtMoney(r.opexAmt * r.ptrsEff)})` : "—", { color: "var(--danger)" })}
                {td(r.netRevenue > 0 ? fmtMoney(r.netRevenue * r.ptrsEff) : "—")}
                {td(r.pwNetIncome !== 0 ? fmtMoney(r.pwNetIncome) : r.pwRdCost > 0 ? `(${fmtMoney(r.pwRdCost)})` : "—", { bold: true, color: r.pwNetIncome > 0 ? "var(--text)" : r.pwRdCost > 0 ? "var(--danger)" : "var(--text-faint)" })}
                {td(fmtMoney(r.dcf), { bold: true, color: r.dcf >= 0 ? "var(--accent)" : "var(--danger)" })}
                {td(r.pwRdCost > 0 ? `(${fmtMoney(r.pwRdCost)})` : "—", { color: "var(--danger)" })}
                {td(`(${fmtMoney(r.cumExpCosts)})`, { color: "var(--danger)" })}
                {td(fmtMoney(r.eNPV), { bold: true, color: r.eNPV >= 0 ? "var(--accent)" : "var(--danger)" })}
                {td(r.cumExpCosts > 0 ? r.pi.toFixed(2) + "x" : "—", { color: r.pi >= 1 ? "var(--accent)" : r.pi > 0 ? "var(--warning, #fbbf24)" : "var(--danger)" })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "2px solid var(--border)" }}>
              <td colSpan={14} style={{ padding: "8px 8px", fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}>eNPV (rNPV)</td>
              <td style={{ padding: "8px 8px", textAlign: "right", fontWeight: 800, fontSize: 14, color: finalENPV >= 0 ? "var(--accent)" : "var(--danger)", fontFamily: "var(--font-mono)" }}>{fmtMoney(finalENPV)}</td>
              <td style={{ padding: "8px 8px", textAlign: "right", fontWeight: 700, fontFamily: "var(--font-mono)", color: finalPI >= 1 ? "var(--accent)" : "var(--danger)" }}>{finalPI.toFixed(2)}x</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 10, color: "var(--text-faint)", lineHeight: 1.6 }}>
        PW = Probability-weighted (× PTRS) · eNPV = Expected NPV = cumulative DCF · PI = Profitability Index = eNPV / Total Expected R&D Costs · Revenue ramp: 20/50/80/100% · Post-LOE: 50% erosion · COGS {fmtPct(cogs)} · Tax {fmtPct(tax)}
      </div>
    </>
  );
}

// ─── Indication Row ──────────────────────────────────────────────────────────
function IndicationRow({ ind, globalPtrs, valuation, numIndications, onUpdate, onRemove }: {
  ind: Indication;
  globalPtrs: number;
  valuation: Valuation;
  numIndications: number;
  onUpdate: (id: string, updates: Partial<Indication>) => void;
  onRemove: (id: string) => void;
}) {
  const effectivePtrs = ind.ptrs ?? globalPtrs;
  const revenuePV = useMemo(() => computeRevenuePV({
    ...valuation,
    peakSales: ind.peakSales ?? valuation.peakSales,
    launchYear: ind.launchYear ?? valuation.launchYear,
    loeYear: ind.loeYear ?? valuation.loeYear,
  }), [ind.peakSales, ind.launchYear, ind.loeYear, valuation]);
  const rnpv = Math.round(effectivePtrs * revenuePV);

  const cellInput = (type: "text" | "number", val: string | number | undefined, placeholder: string, onChange: (v: string) => void) => (
    <input type={type} className="input-base" style={{ fontSize: 12, padding: "4px 8px", minWidth: 0 }}
      value={val ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );

  const effectiveDevCost = ind.devCostPV ?? 0;
  const rnpvAfterDev = Math.round(effectivePtrs * revenuePV - effectiveDevCost);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(130px, 2fr) 90px 68px 68px 64px 80px 80px 80px 24px", gap: 6, alignItems: "center", marginBottom: 6 }}>
      {cellInput("text", ind.name, "Indication name", (v) => onUpdate(ind.id, { name: v }))}
      {cellInput("number", ind.peakSales != null ? ind.peakSales / 1e6 : "", String((valuation.peakSales ?? 0) / 1e6), (v) => onUpdate(ind.id, { peakSales: Number(v) * 1e6 }))}
      {cellInput("number", ind.launchYear ?? "", String(valuation.launchYear ?? ""), (v) => onUpdate(ind.id, { launchYear: v ? Number(v) : undefined }))}
      {cellInput("number", ind.loeYear ?? "", String(valuation.loeYear ?? ""), (v) => onUpdate(ind.id, { loeYear: v ? Number(v) : undefined }))}
      {cellInput("number", ind.ptrs != null ? +(ind.ptrs * 100).toFixed(1) : "", +(effectivePtrs * 100).toFixed(1) + "%", (v) => onUpdate(ind.id, { ptrs: v ? Number(v) / 100 : undefined }))}
      {cellInput("number", ind.devCostPV != null ? ind.devCostPV / 1e6 : "", String(Math.round((valuation.devCostPV ?? 0) / Math.max(1, numIndications) / 1e6)), (v) => onUpdate(ind.id, { devCostPV: v ? Number(v) * 1e6 : undefined }))}
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }}>{fmtMoney(revenuePV)}</div>
      <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right", color: rnpvAfterDev >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmtMoney(rnpvAfterDev)}</div>
      <button onClick={() => onRemove(ind.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", fontSize: 16, lineHeight: 1, padding: 0, textAlign: "center" }}>×</button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function HomePage() {
  const { data: session } = useSession();
  const [v, setV] = useState<Valuation>({ ...DEFAULT_VALUATION });
  const [saved, setSaved] = useState<Record<string, Valuation>>({});
  const [showSaved, setShowSaved] = useState(false);
  const [patentResult, setPatentResult] = useState<any>(null);
  const [patentLoading, setPatentLoading] = useState(false);
  const [trialResults, setTrialResults] = useState<CtgovTrial[] | null>(null);
  const [trialSummary, setTrialSummary] = useState("");
  const [trialTotal, setTrialTotal] = useState(0);
  const [autoLoading, setAutoLoading] = useState(false);
  const [showPnL, setShowPnL] = useState(false);
  const [revenueAnalysis, setRevenueAnalysis] = useState<RevenueAnalysisResult | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);
  const [revenueTab, setRevenueTab] = useState(0);
  const [recommendedNctId, setRecommendedNctId] = useState("");
  const [appliedNctIds, setAppliedNctIds] = useState<Set<string>>(new Set());
  const { pushToast, ToastHost } = useToast();

  useEffect(() => setSaved(loadAll()), []);

  const out = useMemo(() => computeOutputs(v), [v]);
  const display: Valuation = useMemo(() => ({ ...v, ...out }), [v, out]);

  function update<K extends keyof Valuation>(key: K, val: Valuation[K]) {
    setV((cur) => ({ ...cur, [key]: val }));
  }

  function onFieldUpdate(updates: Record<string, any>) {
    setV((cur) => {
      const next = { ...cur, ...updates };
      // If peakSales is being set and we have indications, apply it to the first indication
      // (global peakSales is a legacy field; the indications table drives rNPV)
      if ("peakSales" in updates && cur.indications?.length) {
        next.indications = cur.indications.map((ind, i) =>
          i === 0 ? { ...ind, peakSales: updates.peakSales } : ind
        );
      }
      return next;
    });
    const fieldCount = Object.keys(updates).length;
    pushToast(`Applied ${fieldCount} field update${fieldCount > 1 ? "s" : ""} from assistant.`, "success");
  }


  function onApplyTrial(trial: CtgovTrial) {
    const id = cryptoId();
    const indicationName = trial.conditions?.[0] || trial.title?.slice(0, 60) || trial.nctId;
    const newInd: Indication = {
      id,
      name: indicationName,
      launchYear: trial.estimatedLaunchYear,
      phase: trial.phase,
      nctId: trial.nctId,
      sources: trial.sources,
    };
    // Only update sponsor if not already set — never touch global phase in multi-indication mode
    const globalUpdates: Partial<Valuation> = {};
    if (!v.sponsor && trial.sponsor) globalUpdates.sponsor = trial.sponsor;

    setV((cur) => ({
      ...cur,
      ...globalUpdates,
      indications: [...(cur.indications || []), newInd],
      sources: [...(cur.sources || []), ...trial.sources],
    }));
    setAppliedNctIds((prev) => new Set([...prev, trial.nctId]));
    pushToast(`Added "${indicationName}" — set peak sales to complete the row.`, "success", 5000);
  }

  async function onLookupLOE() {
    const drug = v.asset || v.name;
    if (!drug) return pushToast("Enter an Asset name first.", "error");
    setPatentLoading(true);
    setPatentResult(null);
    try {
      const params = new URLSearchParams();
      if (v.sponsor) params.set("sponsor", v.sponsor);
      const res = await fetch(`/api/loe-full/${encodeURIComponent(drug)}?${params}`);
      if (!res.ok) throw new Error("LOE lookup failed");
      const data = await res.json();
      setPatentResult(data);
      if (data.loeYear) {
        setV((cur) => ({ ...cur, loeYear: data.loeYear, sources: [...(cur.sources || []), ...(data.orangeBook?.sources || [])] }));
        if (data.isDefinitive) {
          pushToast(`LOE confirmed by FDA Orange Book: ${data.loeYear}. Patent context loaded below.`, "success", 8000);
        } else {
          pushToast(`Estimated LOE: ${data.loeMin}–${data.loeMax} (no Orange Book data). Review patent analysis below.`, "success", 8000);
        }
      } else {
        pushToast("No LOE data found. Check the asset name.", "info", 6000);
      }
    } catch (e: any) {
      pushToast(`LOE lookup failed: ${e?.message || "error"}`, "error");
    } finally {
      setPatentLoading(false);
    }
  }

  async function onAutoValue(
    drugOverride?: string,
    sponsorOverride?: string,
    phaseOverride?: string
  ): Promise<string | null> {
    // If called from chat, update the form fields first
    if (drugOverride) {
      setV((cur) => ({
        ...cur,
        asset: drugOverride,
        sponsor: sponsorOverride || cur.sponsor,
        phase: phaseOverride || cur.phase,
      }));
    }

    const drug = drugOverride || v.asset || (v as any).name;
    if (!drug) { pushToast("Enter an Asset name first.", "error"); return null; }
    const sponsor = sponsorOverride || v.sponsor;
    const phase = phaseOverride || v.phase || "Phase 2";

    setAutoLoading(true);
    setTrialResults(null);
    setPatentResult(null);
    try {
      const params = new URLSearchParams({ drug, phase });
      if (sponsor) params.set("sponsor", sponsor);
      const res = await fetch(`/api/auto-value?${params}`);
      if (!res.ok) throw new Error("Auto-value failed");
      const data = await res.json();
      if (!data.indications?.length) {
        pushToast(data.message || `No trials found for "${drug}". Try the generic name.`, "info", 5000);
        return null;
      }
      const totalDevCost = (data.indications as any[]).reduce((s: number, i: any) => s + (i.devCostPV || 0), 0);
      setV((cur) => ({
        ...cur,
        asset: drugOverride || cur.asset,
        loeYear: data.loeYear ?? cur.loeYear,
        sponsor: data.sponsor || cur.sponsor,
        mechanism: data.mechanism || cur.mechanism,
        phase: data.phase || cur.phase,
        indication: cur.indication || data.indications?.[0]?.name || cur.indication,
        launchYear: data.indications?.[0]?.launchYear ?? cur.launchYear,
        indications: data.indications,
        devCostPV: totalDevCost || cur.devCostPV,
        sources: [...(cur.sources || []), ...(data.sources || [])],
      }));
      if (data.loeSource) setPatentResult(data.loeSource);
      if (data.trials?.length) {
        setTrialResults(data.trials);
        setTrialTotal(data.trialsScanned || data.trials.length);
        setTrialSummary(data.summary || "");
      }
      setRecommendedNctId(data.recommendedNctId || "");
      setAppliedNctIds(new Set((data.indications || []).map((i: any) => i.nctId).filter(Boolean)));
      const indCount = data.indications.length;
      const withSales = data.indications.filter((i: any) => i.peakSales).length;
      pushToast(
        `Auto-value complete: ${indCount} indication${indCount !== 1 ? "s" : ""} added${withSales ? `, ${withSales} with peak sales estimates` : ""}${data.loeYear ? `, LOE ${data.loeYear}` : ""}. Running revenue deep-dive…`,
        "success", 8000
      );
      // Auto-trigger deep revenue research
      const indNames = (data.indications || []).map((i: any) => i.name).filter(Boolean);
      if (indNames.length > 0) {
        setTimeout(() => onResearchRevenue(indNames, drug), 600);
      }

      // Return summary for chat
      const mechStr = data.mechanism ? ` · ${data.mechanism}` : "";
      const loeStr = data.loeYear ? ` · LOE ${data.loeYear}` : "";
      const salesStr = withSales > 0
        ? ` · Peak sales estimates loaded for ${withSales} indication${withSales !== 1 ? "s" : ""}`
        : "";
      return `Valued **${drug}** — ${indCount} indication${indCount !== 1 ? "s" : ""} identified${mechStr}${loeStr}${salesStr}. ${data.summary || ""}`.trim();
    } catch (e: any) {
      pushToast(`Auto-value failed: ${e?.message || "error"}`, "error");
      return null;
    } finally {
      setAutoLoading(false);
    }
  }

  async function onResearchRevenue(indicationNames?: string[], drugOverride?: string) {
    const drug = drugOverride || v.asset || (v as any).name;
    const inds = indicationNames || (v.indications || []).map(i => i.name).filter(Boolean);
    if (!drug) return pushToast("Enter an Asset name first.", "error");
    if (inds.length === 0) return pushToast("Add at least one indication first (run Auto-Valuate or add manually).", "error");
    setRevenueLoading(true);
    setRevenueAnalysis(null);
    setRevenueTab(0);
    try {
      const res = await fetch("/api/revenue-assumptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drug, phase: v.phase || "Phase 2", indications: inds, sponsor: v.sponsor }),
      });
      if (!res.ok) throw new Error("Revenue analysis failed");
      const data: RevenueAnalysisResult = await res.json();
      setRevenueAnalysis(data);
      const withEstimates = data.indications.filter(i => i.peakSalesM > 0).length;

      // Auto-apply peak sales to indications that have $0 (e.g. stub path where Claude had no data)
      setV((cur) => {
        if (!cur.indications?.length) return cur;
        const anyMissing = cur.indications.some(ind => !ind.peakSales || ind.peakSales === 0);
        if (!anyMissing) return cur;
        const updated = cur.indications.map((ind, i) => {
          if (ind.peakSales && ind.peakSales > 0) return ind;
          const estimate = data.indications[i]?.peakSalesM;
          return estimate && estimate > 0 ? { ...ind, peakSales: Math.round(estimate * 1e6) } : ind;
        });
        return { ...cur, indications: updated };
      });

      pushToast(`Revenue research complete: ${withEstimates}/${data.indications.length} indications with estimates.`, "success", 8000);
    } catch (e: any) {
      pushToast(`Revenue research failed: ${e?.message || "error"}`, "error");
    } finally {
      setRevenueLoading(false);
    }
  }

  async function onSave(): Promise<Valuation> {
    const id = v.id || cryptoId();
    const slug = v.slug || `${(v.asset || "valuation").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomSlug()}`;
    // Persist computed panels alongside the valuation so they restore on load
    const next = {
      ...v, id, slug, updatedAt: new Date().toISOString(),
      _patentResult: patentResult ?? undefined,
      _trialResults: trialResults ?? undefined,
      _trialSummary: trialSummary || undefined,
      _trialTotal: trialTotal || undefined,
      _revenueAnalysis: revenueAnalysis ?? undefined,
    };
    const all = { ...saved, [id]: next };
    setSaved(all); saveAll(all); setV(next);
    pushToast("Saved locally.", "success");
    await fetch("/api/valuations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => {});
    return next;
  }

  function onLoad(id: string) {
    const rec = saved[id];
    if (!rec) return;
    setV(rec);
    // Restore panels if they were saved
    if (rec._patentResult) setPatentResult(rec._patentResult);
    if (rec._trialResults) { setTrialResults(rec._trialResults); setTrialSummary(rec._trialSummary || ""); setTrialTotal(rec._trialTotal || 0); }
    if (rec._revenueAnalysis) setRevenueAnalysis(rec._revenueAnalysis);
    setShowSaved(false);
    pushToast(`Loaded: ${rec.asset || rec.name || id}`, "success");
  }

  async function onShare() {
    const saved = v.slug ? { ...v } : await onSave();
    const slug = saved.slug!;
    await fetch(`/api/valuation/share/${encodeURIComponent(slug)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...display, slug }),
    }).catch(() => {});
    const url = `${window.location.origin}/share/${slug}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    pushToast("Share URL copied to clipboard.", "success");
  }

  function onNew() {
    setV({ ...DEFAULT_VALUATION });
    pushToast("New valuation started.", "success");
  }

  function addIndication() {
    const id = cryptoId();
    const newInd: Indication = {
      id, name: "",
      peakSales: v.peakSales,
      launchYear: v.launchYear,
      loeYear: v.loeYear,
    };
    setV((cur) => ({ ...cur, indications: [...(cur.indications || []), newInd] }));
  }

  function updateIndication(id: string, updates: Partial<Indication>) {
    setV((cur) => ({
      ...cur,
      indications: (cur.indications || []).map((ind) => ind.id === id ? { ...ind, ...updates } : ind),
    }));
  }

  function removeIndication(id: string) {
    setV((cur) => ({
      ...cur,
      indications: (cur.indications || []).filter((ind) => ind.id !== id),
    }));
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(display, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${(v.asset || "valuation").replace(/\s+/g, "_")}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportCSV() {
    const asset = v.asset || "valuation";
    const disc = v.discountRate ?? 0.12;
    const cogs = v.cogsPct ?? 0.2;
    const tax = v.taxRate ?? 0.21;
    const distPct = v.distributionPct ?? 0.05;
    const opexPct = v.commercialOpexPct ?? 0.20;
    const ptrsVal = out.ptrs ?? 0;
    const now = new Date().getFullYear();

    const inds = (v.indications && v.indications.length > 0) ? v.indications : [{
      id: "s", name: v.indication || asset,
      peakSales: v.peakSales, launchYear: v.launchYear, loeYear: v.loeYear,
      ptrs: v.ptrs, devCostPV: v.devCostPV,
    }];
    const minLaunch = Math.min(...inds.map(i => i.launchYear ?? v.launchYear ?? now + 3));
    const maxLoe = Math.max(...inds.map(i => i.loeYear ?? v.loeYear ?? now + 13));
    const devYears: number[] = [];
    for (let y = now; y < minLaunch; y++) devYears.push(y);
    if (devYears.length === 0) devYears.push(now);
    const totalDevCostNominal = (v.devCostPV ?? 0) * (1 + disc);
    const annualDevCost = totalDevCostNominal / Math.max(1, devYears.length);
    const ramps: Record<number, number> = { 0: 0.2, 1: 0.5, 2: 0.8, 3: 1.0 };

    const rows: string[][] = [];
    // Summary
    rows.push(["Asset", asset]);
    rows.push(["Sponsor", v.sponsor || ""]);
    rows.push(["Phase", v.phase || ""]);
    rows.push(["Mechanism", v.mechanism || ""]);
    rows.push(["Discount Rate", `${(disc * 100).toFixed(1)}%`]);
    rows.push(["PTRS", `${(ptrsVal * 100).toFixed(1)}%`]);
    rows.push(["rNPV ($M)", String(Math.round((out.rnpv ?? 0) / 1e6))]);
    rows.push(["Revenue PV ($M)", String(Math.round((out.revenuePV ?? 0) / 1e6))]);
    rows.push(["Dev Cost PV ($M)", String(Math.round((out.devCostPV ?? 0) / 1e6))]);
    rows.push([]);

    // DCF table
    rows.push(["Year", "Phase", "PTRS", "Disc Factor", "PW R&D Cost ($M)", "Gross Revenue ($M)", "COGS ($M)", "Dist ($M)", "Opex ($M)", "Net Revenue ($M)", "Net Income ($M)", "PW Net Income ($M)", "DCF ($M)", "Cum eNPV ($M)", "PI"]);

    let cumExpCosts = 0; let cumDcf = 0;
    devYears.forEach(yr => {
      const t = yr - now;
      const df = 1 / Math.pow(1 + disc, Math.max(0, t));
      const pwRdCost = annualDevCost * ptrsVal;
      const dcf = -pwRdCost * df;
      cumExpCosts += pwRdCost; cumDcf += dcf;
      const m = (n: number) => (n / 1e6).toFixed(1);
      rows.push([String(yr), "R&D", `${(ptrsVal*100).toFixed(1)}%`, df.toFixed(3),
        `(${m(pwRdCost)})`, "—", "—", "—", "—", "—", "—", "—", m(dcf), m(cumDcf), cumExpCosts > 0 ? (cumDcf/cumExpCosts).toFixed(2)+"x" : "—"]);
    });

    for (let yr = minLaunch; yr <= maxLoe + 1; yr++) {
      const t = yr - now;
      const df = 1 / Math.pow(1 + disc, Math.max(0, t));
      let grossRevenue = 0;
      inds.forEach(ind => {
        const ly = ind.launchYear ?? v.launchYear ?? minLaunch;
        const loe = ind.loeYear ?? v.loeYear ?? maxLoe;
        const ps = ind.peakSales ?? v.peakSales ?? 0;
        if (yr < ly || yr > loe + 1) return;
        const i = yr - ly;
        const pct = i <= 3 ? (ramps[i] ?? 1) : (yr <= loe ? 1 : 0.5);
        grossRevenue += ps * pct;
      });
      if (grossRevenue === 0) continue;
      const cogsAmt = grossRevenue * cogs;
      const distAmt = grossRevenue * distPct;
      const opexAmt = grossRevenue * opexPct;
      const netRevenue = grossRevenue - cogsAmt - distAmt - opexAmt;
      const netIncome = netRevenue * (1 - tax);
      const pwNetIncome = netIncome * ptrsVal;
      const dcf = pwNetIncome * df;
      cumDcf += dcf;
      const m = (n: number) => (n / 1e6).toFixed(1);
      rows.push([String(yr), yr === minLaunch ? "Launch" : "—", `${(ptrsVal*100).toFixed(1)}%`, df.toFixed(3),
        "—", m(grossRevenue), `(${m(cogsAmt)})`, `(${m(distAmt)})`, `(${m(opexAmt)})`,
        m(netRevenue), m(netIncome), m(pwNetIncome), m(dcf), m(cumDcf),
        cumExpCosts > 0 ? (cumDcf/cumExpCosts).toFixed(2)+"x" : "—"]);
    }
    rows.push([]);
    rows.push(["eNPV (rNPV)", `$${(cumDcf/1e6).toFixed(1)}M`]);

    const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${asset.replace(/\s+/g, "_")}_DCF.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const rnpvPositive = (out.rnpv ?? 0) >= 0;
  void rnpvPositive; // used in MetricCard sub text

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <Head>
        <title>{v.asset ? `${v.asset} — DrugValue` : "DrugValue — Pharma Valuation Platform"}</title>
        <meta name="description" content="AI-powered drug asset valuation with rNPV, PTRS, and probability-adjusted cash flows." />
      </Head>

      {/* Header */}
      <header style={{
        borderBottom: "1px solid rgba(255,255,255,0.2)",
        background: "rgba(0,0,0,0.2)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        position: "sticky", top: 0, zIndex: 50,
      }}>
        <div style={{ maxWidth: 1300, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <Link href="/" style={{ textDecoration: "none" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, color: "var(--accent)", letterSpacing: "-0.02em" }}>DrugValue</span>
            </Link>
            {v.asset && (
              <span style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                / {v.asset}{v.indication ? ` · ${v.indication}` : ""}
              </span>
            )}
          </div>
          <div className="header-actions" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ThemeToggle />
            <button className="btn btn-ghost" onClick={() => setShowSaved((s) => !s)} style={{ fontSize: 12 }}>
              Saved ({Object.keys(saved).length})
            </button>
            <button className="btn btn-ghost" onClick={exportCSV} style={{ fontSize: 12 }}>CSV</button>
            <button className="btn btn-ghost" onClick={exportJSON} style={{ fontSize: 12 }}>JSON</button>
            <button className="btn btn-outline" onClick={onNew} style={{ fontSize: 12 }}>+ New</button>
            <button className="btn btn-outline" onClick={onShare} style={{ fontSize: 12 }}>Share ↗</button>
            <button className="btn btn-outline" onClick={() => setShowPnL(true)} style={{ fontSize: 12 }}>P&amp;L ↗</button>
            <button className="btn btn-primary" onClick={onSave} style={{ fontSize: 12 }}>Save</button>
            {session ? (
              <button className="btn btn-ghost" onClick={() => signOut()} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                {session.user?.image && <img src={session.user.image} alt="" style={{ width: 20, height: 20, borderRadius: "50%" }} />}
                Sign out
              </button>
            ) : (
              <button className="btn btn-outline" onClick={() => signIn()} style={{ fontSize: 12 }}>
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Saved dropdown */}
      {showSaved && (
        <div style={{
          position: "fixed", top: 57, right: 24, zIndex: 100, minWidth: 280,
          background: "rgba(10,30,20,0.85)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.2)", borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)", padding: 12,
        }}>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 8, padding: "0 4px" }}>SAVED VALUATIONS</div>
          {Object.keys(saved).length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 4px" }}>No saved valuations yet.</div>
          ) : (
            Object.entries(saved).map(([id, one]) => (
              <button key={id} onClick={() => onLoad(id)} style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
                borderRadius: 8, border: "none", background: "transparent", cursor: "pointer",
                fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)",
                transition: "background 0.1s",
              }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-subtle)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ fontWeight: 500 }}>{one.asset || one.name || id}</div>
                {one.indication && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{one.indication}</div>}
              </button>
            ))
          )}
        </div>
      )}

      <div style={{ maxWidth: 1300, margin: "0 auto", padding: "24px 24px 0" }}>
        <AssistantPanel
          valuation={display}
          onFieldUpdate={onFieldUpdate}
          onAutoValue={onAutoValue}
        />
      </div>

      <main style={{ maxWidth: 1300, margin: "0 auto", padding: "0 24px 24px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Key Metrics */}
          <div className="animate-fade-up metrics-grid">
            <MetricCard label="rNPV" value={fmtMoney(out.rnpv)} gradient="linear-gradient(135deg, #059669, #10b981)" sub={rnpvPositive ? "Risk-adjusted NPV" : "Negative — check inputs"} />
            <MetricCard label="PTRS" value={fmtPct(out.ptrs)} gradient="linear-gradient(135deg, #1d4ed8, #3b82f6)" sub={out.mechLabel || `Phase: ${v.phase}`} />
            <MetricCard label="Revenue PV" value={fmtMoney(out.revenuePV)} gradient="linear-gradient(135deg, #7c3aed, #a855f7)" sub="Undiscounted at PTRS=1" />
            <MetricCard label="Dev Cost PV" value={fmtMoney(out.devCostPV)} gradient="linear-gradient(135deg, #ea580c, #f97316)" sub="Investment" />
            <MetricCard label="ROI" value={out.roi != null ? out.roi.toFixed(1) + "x" : "—"} gradient="linear-gradient(135deg, #b45309, #eab308)" sub="rNPV / Dev Cost" />
          </div>

          {/* Inputs */}
          <Card>
            <SectionLabel>Asset Details</SectionLabel>
            <div className="form-grid-4" style={{ marginBottom: 16 }}>
              <FieldInput label="Asset / Compound Name" value={v.asset || ""} onChange={(x) => update("asset", x)} />
              <FieldInput label="Sponsor / Company" value={v.sponsor || ""} onChange={(x) => update("sponsor", x)} />
              <FieldInput label="Indication" value={v.indication || ""} onChange={(x) => update("indication", x)} />
              <FieldInput label="Mechanism of Action" value={v.mechanism || ""} onChange={(x) => update("mechanism", x)} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <FieldSelect label="Development Phase" value={v.phase || ""} onChange={(x) => update("phase", x as any)} options={["", "Preclinical", "Phase 1", "Phase 2", "Phase 3", "Filed", "Approved"]} />
            </div>

            <div style={{ borderTop: "1px solid var(--border)", margin: "16px 0" }} />
            <SectionLabel>Financial Assumptions</SectionLabel>
            <div className="form-grid-3" style={{ marginBottom: 16 }}>
              <FieldNumber label="Peak Sales" value={v.peakSales} onChange={(x) => update("peakSales", x)} hint="USD" />
              <FieldNumber label="Discount Rate" value={v.discountRate} onChange={(x) => update("discountRate", x)} isPct hint="%" />
              <FieldNumber label="Dev Cost PV" value={v.devCostPV} onChange={(x) => update("devCostPV", x)} hint="USD" />
              <FieldNumber label="COGS %" value={v.cogsPct} onChange={(x) => update("cogsPct", x)} isPct hint="%" />
              <FieldNumber label="Tax Rate" value={v.taxRate} onChange={(x) => update("taxRate", x)} isPct hint="%" />
              <FieldNumber label="Working Capital %" value={v.workingCapitalPct} onChange={(x) => update("workingCapitalPct", x)} isPct hint="%" />
              {v.ownerType === "Licensor" && (
                <FieldNumber label="Avg Royalty %" value={v.avgRoyalty} onChange={(x) => update("avgRoyalty", x)} isPct hint="%" />
              )}
            </div>

            <div style={{ borderTop: "1px solid var(--border)", margin: "16px 0" }} />
            <SectionLabel>Timeline</SectionLabel>
            <div className="form-grid-3" style={{ marginBottom: 16 }}>
              <FieldNumber label="Launch Year" value={v.launchYear} onChange={(x) => update("launchYear", x)} integer />
              <FieldNumber label="LOE Year" value={v.loeYear} onChange={(x) => update("loeYear", x)} integer hint="Loss of Exclusivity" />
              <FieldNumber label="PTRS Override" value={v.ptrs} onChange={(x) => update("ptrs", x)} isPct hint="Leave blank = auto" />
            </div>

            <div style={{ borderTop: "1px solid var(--border)", margin: "16px 0" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <SectionLabel>Indications</SectionLabel>
              <button className="btn btn-outline" onClick={addIndication} style={{ fontSize: 11, padding: "3px 10px" }}>+ Add</button>
            </div>
            {(!v.indications || v.indications.length === 0) ? (
              <div style={{ fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--font-mono)", marginBottom: 8 }}>
                Add indications to model multiple revenue streams and see a combined rNPV breakdown. Fields above become defaults for each row.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(130px, 2fr) 90px 68px 68px 64px 80px 80px 80px 24px", gap: 6, marginBottom: 6 }}>
                  {["Indication", "Peak Sales ($M)", "Launch", "LOE", "PTRS%", "Dev Cost ($M)", "Rev PV", "rNPV", ""].map((h, i) => (
                    <div key={i} style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: "var(--font-mono)" }}>{h}</div>
                  ))}
                </div>
                {v.indications.map((ind) => (
                  <IndicationRow key={ind.id} ind={ind} globalPtrs={out.ptrs} valuation={v} numIndications={v.indications!.length} onUpdate={updateIndication} onRemove={removeIndication} />
                ))}
                {v.indications.length > 1 && (
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(130px, 2fr) 90px 68px 68px 64px 80px 80px 80px 24px", gap: 6, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", gridColumn: "1 / 6" }}>Combined</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }}>{fmtMoney(out.devCostPV)}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }}>{fmtMoney(out.revenuePV)}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", textAlign: "right", color: out.rnpv >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmtMoney(out.rnpv)}</div>
                    <div />
                  </div>
                )}
              </div>
            )}

            <div style={{ marginBottom: 10 }}>
              <button className="btn btn-primary" onClick={() => onAutoValue()} disabled={autoLoading}
                style={{ fontSize: 14, padding: "10px 22px", fontWeight: 700, letterSpacing: "0.01em", width: "100%", justifyContent: "center" }}>
                {autoLoading ? "⏳ Researching trials, LOE & revenue… (20–30 s)" : "⚡ Auto-Valuate"}
              </button>
              {autoLoading && (
                <div style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "center", marginTop: 6 }}>
                  Scanning CT.gov · Inferring LOE · Estimating peak sales via web search + AI
                </div>
              )}
            </div>
            {v.sources && v.sources.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "center", marginTop: 2 }}>
                {v.sources.length} source{v.sources.length > 1 ? "s" : ""} attached
              </div>
            )}

            {v.sources && v.sources.length > 0 && (
              <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Sources</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {v.sources.map((s, i) => (
                    <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ opacity: 0.5 }}>[{i + 1}]</span> {s.label} ↗
                    </a>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Clinical Trial Results */}
          {trialResults && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <SectionLabel>Clinical Trials — {v.asset || (v as any).name}</SectionLabel>
                <button onClick={() => setTrialResults(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-faint)", lineHeight: 1 }}>×</button>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: trialSummary ? 10 : 14 }}>
                Showing {trialResults.length} AI-selected trials from {trialTotal} experimental-arm matches · Applying adds an indication row with launch year pre-filled.
              </div>
              {trialSummary && (
                <div style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
                  {trialSummary}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {trialResults.map((t) => {
                  const phaseColors: Record<string, { bg: string; text: string }> = {
                    "Phase 3": { bg: "#dbeafe", text: "#1e40af" },
                    "Phase 2": { bg: "#ede9fe", text: "#6d28d9" },
                    "Phase 1": { bg: "#ffedd5", text: "#c2410c" },
                    "Phase 4": { bg: "#dcfce7", text: "#166534" },
                  };
                  const statusColors: Record<string, { bg: string; text: string }> = {
                    COMPLETED:             { bg: "#dcfce7", text: "#166534" },
                    ACTIVE_NOT_RECRUITING: { bg: "#dbeafe", text: "#1e40af" },
                    RECRUITING:            { bg: "#ccfbf1", text: "#0f766e" },
                    NOT_YET_RECRUITING:    { bg: "#fef3c7", text: "#92400e" },
                  };
                  const pc = phaseColors[t.phase || ""] || { bg: "#f1f5f9", text: "#475569" };
                  const sc = statusColors[t.status || ""] || { bg: "#f1f5f9", text: "#475569" };
                  const isApplied = appliedNctIds.has(t.nctId);
                  const isRecommended = recommendedNctId === t.nctId;
                  return (
                    <div key={t.nctId} style={{
                      border: `1px solid ${isRecommended ? "rgba(16,185,129,0.4)" : "var(--border)"}`,
                      background: isRecommended ? "rgba(16,185,129,0.04)" : undefined,
                      borderRadius: 12, padding: "12px 16px",
                      display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center",
                    }}>
                      <div>
                        <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
                          {isRecommended && (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(16,185,129,0.15)", color: "var(--accent)" }}>
                              ★ Recommended
                            </span>
                          )}
                          {t.phaseRaw && (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: pc.bg, color: pc.text }}>
                              {t.phaseRaw}
                            </span>
                          )}
                          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: sc.bg, color: sc.text }}>
                            {t.statusLabel}
                          </span>
                          <a href={`https://clinicaltrials.gov/study/${t.nctId}`} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-mono)", alignSelf: "center", textDecoration: "none" }}>
                            {t.nctId} ↗
                          </a>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3, lineHeight: 1.4 }}>
                          {t.title ? (t.title.length > 100 ? t.title.slice(0, 100) + "…" : t.title) : t.nctId}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 12, flexWrap: "wrap", marginBottom: t.claudeReason ? 6 : 0 }}>
                          {t.sponsor && <span>🏢 {t.sponsor}</span>}
                          {t.conditions?.[0] && <span>🎯 {t.conditions[0]}</span>}
                          {t.estimatedLaunchYear && <span>🚀 Est. launch ~{t.estimatedLaunchYear}</span>}
                          {(t.primaryCompletionDate || t.completionDate) && (
                            <span>✓ Ends {(t.completionDate || t.primaryCompletionDate || "").slice(0, 7)}</span>
                          )}
                        </div>
                        {t.claudeReason && (
                          <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                            {t.claudeReason}
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                        <button className="btn btn-outline" onClick={() => onApplyTrial(t)}
                          style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", borderColor: isRecommended ? "var(--accent)" : undefined, color: isRecommended ? "var(--accent)" : undefined }}>
                          {isApplied ? "+ Add again" : "Apply →"}
                        </button>
                        {isApplied && (
                          <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>✓ Added</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* LOE + Patent results */}
          {patentResult && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <SectionLabel>LOE Analysis</SectionLabel>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn btn-ghost" onClick={onLookupLOE} disabled={patentLoading || autoLoading}
                    style={{ fontSize: 11, padding: "3px 10px" }}>
                    {patentLoading ? "…" : "↻ Refresh"}
                  </button>
                  <button onClick={() => setPatentResult(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-faint)", lineHeight: 1 }}>×</button>
                </div>
              </div>

              {/* Main LOE banner — green if OB confirmed, blue if patent estimate */}
              {patentResult.loeYear ? (
                <div style={{
                  background: patentResult.isDefinitive
                    ? "linear-gradient(135deg, #059669, #10b981)"
                    : patentResult.isBpcia
                    ? "linear-gradient(135deg, #7c3aed, #8b5cf6)"
                    : "linear-gradient(135deg, #1d4ed8, #3b82f6)",
                  borderRadius: 12, padding: "14px 20px", marginBottom: 16,
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
                }}>
                  <div>
                    <div style={{ fontSize: 10, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                      {patentResult.isDefinitive
                        ? "LOE Confirmed — FDA Orange Book"
                        : patentResult.isBpcia
                        ? `LOE Estimated — Patent Analysis (BPCIA floor: ${patentResult.orangeBook?.loeDate?.slice(0,4) ?? "—"})`
                        : "Estimated LOE Range — Patent Analysis"}
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: "#fff", fontFamily: "var(--font-display)", lineHeight: 1.1 }}>
                      {patentResult.isDefinitive
                        ? patentResult.loeYear
                        : (patentResult.loeMin != null && patentResult.loeMax != null && patentResult.loeMin !== patentResult.loeMax)
                          ? `${patentResult.loeMin}–${patentResult.loeMax}`
                          : (patentResult.loeYear ?? "—")}
                    </div>
                    {!patentResult.isDefinitive && (
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", marginTop: 2 }}>
                        Best estimate: {patentResult.loeYear ?? "—"} · Confidence: {patentResult.patents?.confidence || "—"}
                      </div>
                    )}
                    {patentResult.isDefinitive && patentResult.orangeBook?.reasons?.length > 0 && (
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", marginTop: 2 }}>
                        {patentResult.orangeBook.reasons[0]}
                      </div>
                    )}
                  </div>
                  <button className="btn" onClick={() => setV(cur => ({ ...cur, loeYear: patentResult.loeYear }))}
                    style={{ background: "rgba(255,255,255,0.9)", color: patentResult.isDefinitive ? "#059669" : patentResult.isBpcia ? "#7c3aed" : "#1d4ed8", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                    Use {patentResult.loeYear} →
                  </button>
                </div>
              ) : (
                <div style={{ background: "rgba(0,0,0,0.05)", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "var(--text-muted)" }}>
                  No LOE data found. Try a different asset name or check spelling.
                </div>
              )}

              {/* ── Section 1: FDA Orange Book / BPCIA ── always shown ── */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  {patentResult.orangeBook?.sources?.some((s: any) => (s.label || "").includes("Purple Book"))
                    ? "FDA Purple Book / BPCIA Exclusivity"
                    : "FDA Orange Book / Exclusivity"}
                </div>
                {patentResult.orangeBook?.reasons?.length > 0 ? (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {patentResult.orangeBook.reasons.map((r: string, i: number) => (
                        <div key={i} style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>• {r}</div>
                      ))}
                    </div>
                    {patentResult.orangeBook.sources?.length > 0 && (
                      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                        {patentResult.orangeBook.sources.map((s: any, i: number) => (
                          s.url
                            ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>{s.label} ↗</a>
                            : <div key={i} style={{ fontSize: 12, color: "var(--text-faint)" }}>{s.label}</div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" }}>FDA database not queried or drug not found.</div>
                )}
              </div>

              {/* ── Section 2: Patent Analysis ── always shown ── */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                  Patent Analysis {patentResult.patents?.found != null ? `(${patentResult.patents.found} found)` : ""}
                </div>
                {patentResult.patents?.patentContext ? (
                  <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>{patentResult.patents.patentContext}</p>
                ) : (
                  <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" }}>No patent search results available.</p>
                )}
                {patentResult.patents?.keyPatents?.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {patentResult.patents.keyPatents.filter((p: any) => p.relevance === "high" || p.relevance === "medium").map((p: any, i: number) => (
                      <div key={i} style={{
                        background: p.relevance === "high" ? "rgba(29,78,216,0.06)" : "rgba(0,0,0,0.03)",
                        border: `1px solid ${p.relevance === "high" ? "rgba(29,78,216,0.2)" : "rgba(0,0,0,0.08)"}`,
                        borderRadius: 10, padding: "10px 14px",
                        display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "8px 12px", alignItems: "start",
                      }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20,
                          background: p.type === "compound" ? "#dbeafe" : p.type === "formulation" ? "#ede9fe" : "#fef3c7",
                          color: p.type === "compound" ? "#1e40af" : p.type === "formulation" ? "#6d28d9" : "#92400e",
                          whiteSpace: "nowrap", alignSelf: "center",
                        }}>{p.type}</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{p.title}</div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.reason}</div>
                        </div>
                        <div style={{ textAlign: "right", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          <div>Filed: {p.filingYear || "—"}</div>
                          <div>Exp: ~{p.estimatedExpiry || "—"}</div>
                          {p.url ? (
                            <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ color: "#1d4ed8", textDecoration: "none", fontSize: 11 }}>{p.number} ↗</a>
                          ) : (
                            <a href={`https://patents.google.com/patent/${(p.number || "").replace(/\s/g,"")}`} target="_blank" rel="noopener noreferrer" style={{ color: "#1d4ed8", textDecoration: "none", fontSize: 11 }}>{p.number} ↗</a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Section 3: Market Intelligence ── always shown ── */}
              <div style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                  Market Intelligence {patentResult.patents?.marketIntelligence?.length > 0 ? `(${patentResult.patents.marketIntelligence.length} sources)` : ""}
                </div>
                {patentResult.patents?.marketIntelligence?.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {patentResult.patents.marketIntelligence.map((m: any, i: number) => (
                      <div key={i} style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 8, padding: "8px 12px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#4f46e5" }}>
                            {m.url ? <a href={m.url} target="_blank" rel="noopener noreferrer" style={{ color: "#4f46e5", textDecoration: "none" }}>{m.source || "Source"}</a> : (m.source || "Source")}
                          </span>
                          {m.loeYearMentioned && (
                            <span style={{ fontSize: 12, fontWeight: 700, background: "rgba(99,102,241,0.15)", color: "#4f46e5", borderRadius: 4, padding: "1px 7px" }}>
                              LOE ~{m.loeYearMentioned}
                            </span>
                          )}
                        </div>
                        {m.snippet && <p style={{ margin: 0, fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>{m.snippet}</p>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-faint)", fontStyle: "italic" }}>No market intelligence sources retrieved.</div>
                )}
              </div>

              {/* Caveats */}
              {patentResult.patents?.caveats?.length > 0 && (
                <div style={{ marginTop: 12, background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)", borderRadius: 10, padding: "10px 14px" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#92400e", marginBottom: 4 }}>⚠ Important caveats</div>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {patentResult.patents.caveats.map((c: string, i: number) => (
                      <li key={i} style={{ fontSize: 12, color: "#78350f", marginBottom: 2 }}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          )}

          {/* Revenue Assumptions */}
          {(revenueLoading || revenueAnalysis) && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <SectionLabel>Revenue Assumptions</SectionLabel>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -8, marginBottom: 8 }}>
                    AI sell-side analysis · {v.asset} · {v.phase}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn btn-ghost" onClick={() => onResearchRevenue()} disabled={revenueLoading}
                    style={{ fontSize: 11 }}>{revenueLoading ? "⏳" : "↻ Refresh"}</button>
                  <button onClick={() => setRevenueAnalysis(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-faint)", lineHeight: 1 }}>×</button>
                </div>
              </div>

              {revenueLoading && !revenueAnalysis && (
                <div style={{ textAlign: "center", padding: "32px 0" }}>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                    Searching analyst estimates, epidemiology data &amp; comparable drugs…
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                    Running {(v.indications?.length || 1) * 3} searches · Claude synthesizing
                  </div>
                </div>
              )}

              {revenueAnalysis && (() => {
                const inds = revenueAnalysis.indications;
                const active = inds[revenueTab] as IndicationRevenueAnalysis | undefined;
                if (!inds.length || !active) return null;

                const confColors: Record<string, { bg: string; text: string; label: string }> = {
                  high:   { bg: "rgba(16,185,129,0.12)",  text: "var(--accent)", label: "HIGH CONFIDENCE" },
                  medium: { bg: "rgba(59,130,246,0.12)",  text: "#3b82f6",       label: "MEDIUM CONFIDENCE" },
                  low:    { bg: "rgba(251,191,36,0.12)",  text: "#b45309",       label: "LOW — ESTIMATED" },
                };
                const conf = confColors[active.confidence] || confColors.low;

                const stale = revenueAnalysis.drug !== (v.asset || "") ||
                  revenueAnalysis.indications.length !== (v.indications?.length || 0);

                return (
                  <div>
                    {stale && (
                      <div style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)", borderRadius: 8, padding: "8px 14px", marginBottom: 14, fontSize: 12, color: "#92400e" }}>
                        ⚠ Indications have changed — click ↻ Refresh to update.
                      </div>
                    )}

                    {/* Tab strip */}
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 20, borderBottom: "1px solid var(--border)", paddingBottom: 0 }}>
                      {inds.map((ind, i) => (
                        <button key={i} onClick={() => setRevenueTab(i)} style={{
                          background: "none", border: "none", cursor: "pointer", padding: "7px 12px",
                          fontSize: 12, fontFamily: "var(--font-mono)",
                          color: revenueTab === i ? "var(--text)" : "var(--text-muted)",
                          borderBottom: revenueTab === i ? "2px solid var(--accent)" : "2px solid transparent",
                          fontWeight: revenueTab === i ? 600 : 400,
                          whiteSpace: "nowrap",
                        }}>
                          {ind.indication.length > 30 ? ind.indication.slice(0, 28) + "…" : ind.indication}
                        </button>
                      ))}
                    </div>

                    {/* Banner */}
                    <div style={{
                      background: "linear-gradient(135deg, #0f766e, #0d9488)",
                      borderRadius: 12, padding: "16px 20px", marginBottom: 20,
                      display: "grid", gridTemplateColumns: "1fr auto auto", gap: 16, alignItems: "center",
                    }}>
                      <div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "var(--font-display)", fontWeight: 600 }}>
                          Peak Sales — Base Case
                        </div>
                        <div style={{ fontSize: 30, fontWeight: 800, color: "#fff", fontFamily: "var(--font-display)", lineHeight: 1.1 }}>
                          {fmtMoney(active.peakSalesM * 1e6)}
                        </div>
                        <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 12 }}>
                          <span style={{ color: "rgba(255,255,255,0.9)" }}>Bull {fmtMoney(active.bullM * 1e6)} ↑</span>
                          <span style={{ color: "rgba(255,255,255,0.6)" }}>Bear {fmtMoney(active.bearM * 1e6)} ↓</span>
                        </div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: conf.bg, color: conf.text, whiteSpace: "nowrap" }}>
                          {conf.label}
                        </div>
                      </div>
                      <button onClick={() => {
                        const targetId = v.indications?.[revenueTab]?.id;
                        if (targetId) {
                          updateIndication(targetId, { peakSales: Math.round(active.peakSalesM * 1e6) });
                          pushToast(`Applied ${fmtMoney(active.peakSalesM * 1e6)} to "${v.indications?.[revenueTab]?.name || active.indication}".`, "success");
                        }
                      }} style={{ background: "rgba(255,255,255,0.9)", color: "#0f766e", fontWeight: 700, fontSize: 13, padding: "8px 14px", border: "none", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap" }}>
                        Use {fmtMoney(active.peakSalesM * 1e6)} →
                      </button>
                    </div>

                    {/* Methodology — how the estimate was built — always shown */}
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                        How This Estimate Was Built
                      </div>
                      {/* Derivation badges */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                        {active.marketContext?.tamM != null && (
                          <span style={{ fontSize: 12, background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 20, padding: "3px 10px", color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                            TAM {fmtMoney(active.marketContext.tamM * 1e6)}
                          </span>
                        )}
                        {active.marketContext?.penetrationPct != null && (
                          <span style={{ fontSize: 12, background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 20, padding: "3px 10px", color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                            × {active.marketContext.penetrationPct}% penetration
                          </span>
                        )}
                        {active.marketContext?.pricingPerYear != null && (
                          <span style={{ fontSize: 12, background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 20, padding: "3px 10px", color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                            @ {fmtPrice(active.marketContext.pricingPerYear)}/yr WAC
                          </span>
                        )}
                        {(active.analystEstimates?.length ?? 0) > 0 && (
                          <span style={{ fontSize: 12, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: 20, padding: "3px 10px", color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                            {active.analystEstimates.length} analyst estimate{active.analystEstimates.length > 1 ? "s" : ""}
                          </span>
                        )}
                        {(active.comps?.length ?? 0) > 0 && (
                          <span style={{ fontSize: 12, background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 20, padding: "3px 10px", color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                            {active.comps.length} comparable drug{active.comps.length > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <div style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: 10, padding: "12px 16px", fontSize: 13, color: "var(--text)", lineHeight: 1.7 }}>
                        {active.reasoning || "Reasoning not available for this indication."}
                      </div>
                    </div>

                    {/* Analyst Estimates */}
                    {active.analystEstimates?.length > 0 && (
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                          Analyst Estimates ({active.analystEstimates.length})
                        </div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid var(--border)" }}>
                              {["Source", "Estimate", "Year", "Quote"].map(h => (
                                <th key={h} style={{ padding: "5px 10px", textAlign: h === "Source" || h === "Quote" ? "left" : "right", fontSize: 10, color: "var(--text-faint)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {active.analystEstimates.map((est, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                                <td style={{ padding: "6px 10px", color: "var(--text)" }}>
                                  {est.url ? <a href={est.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>{est.source} ↗</a> : est.source}
                                </td>
                                <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: "var(--accent)" }}>{fmtMoney(est.estimateM * 1e6)}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--text-muted)" }}>{est.year || "—"}</td>
                                <td style={{ padding: "6px 10px", color: "var(--text-muted)", fontStyle: "italic", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{est.quote}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Market Context */}
                    {active.marketContext && (
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Market Context</div>
                        <div className="form-grid-3">
                          {active.marketContext.tamM && (
                            <div>
                              <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>Total Addressable Market</div>
                              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)" }}>{fmtMoney(active.marketContext.tamM * 1e6)}</div>
                            </div>
                          )}
                          {active.marketContext.penetrationPct != null && (
                            <div>
                              <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>Peak Penetration</div>
                              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)" }}>{active.marketContext.penetrationPct}%</div>
                            </div>
                          )}
                          {active.marketContext.pricingPerYear && (
                            <div>
                              <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>Annual Price (WAC)</div>
                              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)" }}>{fmtPrice(active.marketContext.pricingPerYear)}/yr</div>
                            </div>
                          )}
                          {active.marketContext.patientPopDesc && (
                            <div style={{ gridColumn: "1 / -1" }}>
                              <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>Patient Population</div>
                              <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{active.marketContext.patientPopDesc}</div>
                            </div>
                          )}
                          {active.marketContext.competitive && (
                            <div style={{ gridColumn: "1 / -1" }}>
                              <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>Competitive Landscape</div>
                              <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{active.marketContext.competitive}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Comparable Drugs */}
                    {active.comps?.length > 0 && (
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Comparable Drugs</div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid var(--border)" }}>
                              {["Drug", "Indication", "Peak Sales", "Rationale"].map(h => (
                                <th key={h} style={{ padding: "5px 10px", textAlign: h === "Peak Sales" ? "right" : "left", fontSize: 10, color: "var(--text-faint)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {active.comps.map((comp, i) => (
                              <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                                <td style={{ padding: "6px 10px", color: "var(--text)", fontWeight: 600 }}>{comp.drug}</td>
                                <td style={{ padding: "6px 10px", color: "var(--text-muted)" }}>{comp.indication}</td>
                                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--accent)", fontWeight: 700 }}>{fmtMoney(comp.peakSalesM * 1e6)}</td>
                                <td style={{ padding: "6px 10px", color: "var(--text-muted)", fontStyle: "italic" }}>{comp.rationale}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Sources */}
                    {active.sources?.length > 0 && (
                      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Sources</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {active.sources.map((s, i) => (
                            <a key={i} href={s.url || "#"} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                              <span style={{ opacity: 0.5 }}>[{i + 1}]</span> {s.label} {s.url ? "↗" : ""}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </Card>
          )}

          {/* Charts */}
          <Card>
            <SectionLabel>Valuation Analysis</SectionLabel>
            <ValuationCharts valuation={display} />
          </Card>

        </div>
      </main>

      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.15)", marginTop: 40, background: "rgba(0,0,0,0.15)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
        <div style={{ maxWidth: 1300, margin: "0 auto", padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--accent)" }}>DrugValue</span>
          <span style={{ fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
            Probability-adjusted drug asset valuation
          </span>
          <span style={{ fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
            © {new Date().getFullYear()}
          </span>
        </div>
      </footer>

      <ToastHost />

      {/* P&L Modal */}
      {showPnL && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowPnL(false); }}>
          <div style={{ background: "var(--bg-card-solid)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-lg)", padding: 28, maxWidth: 1100, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 80px rgba(0,0,0,0.4)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, color: "var(--text)" }}>
                P&amp;L — {v.asset || "Valuation"}
              </div>
              <button onClick={() => setShowPnL(false)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: "var(--text-faint)", lineHeight: 1 }}>×</button>
            </div>

            <PnLTable v={v} out={out} onClose={() => setShowPnL(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
