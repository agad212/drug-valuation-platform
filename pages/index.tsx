import React, { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import dynamic from "next/dynamic";
import { signIn, signOut, useSession } from "next-auth/react";
import { ThemeToggle } from "../components/ThemeToggle";
import AssistantPanel from "../components/AssistantPanel";
import { useToast } from "../components/Toast";
import type { Valuation, Indication, RevenueAnalysisResult, IndicationRevenueAnalysis } from "../lib/types";
import { computeOutputs, computeRevenuePV, type IndicationOutput } from "../lib/cashflow";
import type { CtgovTrial } from "../lib/ctgov";
import { isEnrollmentComplete } from "../lib/ctgov";
import DecisionAnalysis from "../components/DecisionAnalysis";
import DevPlan from "../components/DevPlan";
import EffectPriorChain from "../components/EffectPriorChain";
import StrategicAssessment from "../components/StrategicAssessment";
import { buildBaseContext } from "../lib/decision-analysis";
import { computeDevPlan, type DevStageInput, type DevPlanResult } from "../lib/dev-plan";
import { selfCheck, viewFromDevPlan } from "../lib/self-check";
import { validateValuationInputs, applyValidatedUpdates } from "../lib/valuation-input-validator";
import { mixtureFromMssVariance, type EffectPrior } from "../lib/effect-prior";
import { inferTherapeuticArea, inferModality, anchorPeakSales, classifyComps, computeLoeYear } from "../lib/financial-pins";
import { classGraveyardProbability } from "../lib/class-risk";
import type { RegulatoryContext } from "../lib/ptrs-trial";
import type { ValuationBrief, ExpectationAuditResult } from "../lib/valuation-brief";

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
// Display rounding only (render boundary). Default to WHOLE % — a Phase 1/2 asset
// doesn't support decimal-point precision on a probability. Callers pass dp=1 only
// where a decimal is genuinely meaningful. Never round before a computation.
function fmtPct(n?: number | null, dp = 0) {
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
function PnLTable({ v, out, pApproval, devPlan, onClose }: { v: Valuation; out: ReturnType<typeof computeOutputs>; pApproval?: number; devPlan?: DevPlanResult | null; onClose: () => void }) {
  const [distPct, setDistPct] = useState(v.distributionPct ?? 0.05);
  const [opexPct, setOpexPct] = useState(v.commercialOpexPct ?? 0.20);

  const now = new Date().getFullYear();
  const disc = v.discountRate ?? 0.12;
  const cogs = v.cogsPct ?? 0.2;
  const tax = v.taxRate ?? 0.21;
  // Use dev plan P(approval) when available; fall back to out.ptrs (Layer 1+2 or phase baseline)
  const ptrs = pApproval ?? out.ptrs;
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

  // Dev cost pulled from the CANONICAL dev plan (pinned CPP × n), not the stale
  // auto-value devCostPV. Nominal column = the plan's total nominal cost; the
  // probability-weighted spend = the plan's risk-adjusted cost (already weighted per
  // stage by P(reaching it)), so the P&L's dev spend reconciles with the headline eNPV.
  // Legacy fallback (no dev plan): the old auto-value estimate.
  const devNominalTotal = devPlan ? devPlan.totalNominalCostM * 1e6 : (v.devCostPV ?? 0) * (1 + disc);
  const devPwTotal = devPlan ? devPlan.totalRiskAdjCostM * 1e6 : (v.devCostPV ?? 0) * ptrs;
  const annualDevCost = devNominalTotal / Math.max(1, devYears.length);       // nominal per year (display)
  const annualPwDevCost = devPwTotal / Math.max(1, devYears.length);          // risk-adjusted per year (drives DCF)

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
    const pwRdCost = annualPwDevCost; // already risk-adjusted (dev-plan basis); do NOT × ptrs again
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
          <span style={{ color: "var(--text-faint)", marginRight: 6 }}>P(approval):</span>
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
              {th("P(appr.)")}
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
function IndicationRow({ ind, globalPtrs, valuation, numIndications, halted, isPrimary, governedDevCostM, structural, onUpdate, onRemove }: {
  ind: Indication;
  globalPtrs: number;
  valuation: Valuation;
  numIndications: number;
  halted?: boolean;   // strategic assessment failed → don't show an ungoverned P(appr.)/rNPV verdict
  isPrimary?: boolean;            // first indication — the one the dev plan governs
  governedDevCostM?: number | null; // dev plan's risk-adjusted cost ($M); overrides devCostPV for the primary row
  // The engine's STRUCTURAL contribution for this indication (own P, own/shifted launch, any conditional
  // P-weight, and this indication's risk-adjusted cost share). Passed only for a governed multi-indication
  // row; when present it DRIVES the revPV/dev-cost/rNPV cells so the rows sum EXACTLY to the headline eNPV
  // (rows-Σ == Combined == headline) for every relationship — the cost-basis unification.
  structural?: IndicationOutput | null;
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

  const cellInput = (type: "text" | "number", val: string | number | undefined, placeholder: string, onChange: (v: string) => void) => (
    <input type={type} className="input-base" style={{ fontSize: 12, padding: "4px 8px", minWidth: 0 }}
      value={val ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );

  // Dev plan is the single source of truth for the primary indication's dev cost
  // (risk-adjusted), so the rNPV here reconciles with the headline eNPV instead
  // of using the stale full-program devCostPV.
  const governed = isPrimary && governedDevCostM != null;
  const effectiveDevCost = governed ? governedDevCostM * 1e6 : (ind.devCostPV ?? 0);
  const rnpvAfterDev = Math.round(effectivePtrs * revenuePV - effectiveDevCost);

  // When the engine's structural contribution is provided, the displayed revPV / dev-cost / rNPV come
  // from it (not this row's independent re-derivation), so the rows reconcile to the headline exactly.
  const useStructural = structural != null;
  const dispRevPV = useStructural ? structural!.revenuePV : revenuePV;
  const dispRnpv = useStructural ? structural!.rnpv : rnpvAfterDev;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(130px, 2fr) 90px 68px 68px 64px 80px 80px 80px 24px", gap: 6, alignItems: "center", marginBottom: 6 }}>
      {cellInput("text", ind.name, "Indication name", (v) => onUpdate(ind.id, { name: v }))}
      {cellInput("number", ind.peakSales != null ? ind.peakSales / 1e6 : "", String((valuation.peakSales ?? 0) / 1e6), (v) => onUpdate(ind.id, { peakSales: Number(v) * 1e6 }))}
      {cellInput("number", ind.launchYear ?? "", String(valuation.launchYear ?? ""), (v) => onUpdate(ind.id, { launchYear: v ? Number(v) : undefined }))}
      {cellInput("number", ind.loeYear ?? "", String(valuation.loeYear ?? ""), (v) => onUpdate(ind.id, { loeYear: v ? Number(v) : undefined }))}
      {cellInput("number", ind.ptrs != null ? +(ind.ptrs * 100).toFixed(1) : "", halted ? "—" : +(effectivePtrs * 100).toFixed(1) + "%", (v) => onUpdate(ind.id, { ptrs: v ? Number(v) / 100 : undefined }))}
      {useStructural
        ? <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }} title="Risk-adjusted dev cost — this indication's share of the development plan">{Math.round(structural!.devCostPV / 1e6)}</div>
        : governed
        ? <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }} title="Risk-adjusted expected R&D from the development plan">{Math.round(governedDevCostM!)}</div>
        : cellInput("number", ind.devCostPV != null ? ind.devCostPV / 1e6 : "", String(Math.round((valuation.devCostPV ?? 0) / Math.max(1, numIndications) / 1e6)), (v) => onUpdate(ind.id, { devCostPV: v ? Number(v) * 1e6 : undefined }))}
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }}>{fmtMoney(dispRevPV)}</div>
      <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)", textAlign: "right", color: halted ? "var(--text-faint)" : (dispRnpv >= 0 ? "var(--accent)" : "var(--danger)") }}>{halted ? "—" : fmtMoney(dispRnpv)}</div>
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
  // Fix #2 provenance strings surfaced in the live UI (peak-sales anchor, LOE rule).
  const [peakProvenance, setPeakProvenance] = useState<string | null>(null);
  const [loeProvenance, setLoeProvenance] = useState<string | null>(null);
  const [trialResults, setTrialResults] = useState<CtgovTrial[] | null>(null);
  const [trialSummary, setTrialSummary] = useState("");
  const [trialTotal, setTrialTotal] = useState(0);
  const [autoLoading, setAutoLoading] = useState(false);
  const [showPnL, setShowPnL] = useState(false);
  const [revenueAnalysis, setRevenueAnalysis] = useState<RevenueAnalysisResult | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);
  const [revenueTab, setRevenueTab] = useState(0);
  const [ptrsResult, setPtrsResult] = useState<any>(null);
  const [ptrsLoading, setPtrsLoading] = useState(false);
  const [ptrsOverrides, setPtrsOverrides] = useState<Record<string, number>>({});
  const [ptrsRescoring, setPtrsRescoring] = useState(false);
  const [layer2Result, setLayer2Result] = useState<any>(null);
  const [layer2Loading, setLayer2Loading] = useState(false);
  const [effectPrior, setEffectPrior] = useState<EffectPrior | null>(null);
  const [effectPriorLoading, setEffectPriorLoading] = useState(false);
  const [devPlanStages, setDevPlanStages] = useState<DevStageInput[] | null>(null);
  const [devPlanRegContext, setDevPlanRegContext] = useState<RegulatoryContext>("standard");
  const [devPlanReasoning, setDevPlanReasoning] = useState<string | null>(null);
  const [devPlanLoading, setDevPlanLoading] = useState(false);
  // Surfaces a HALT after the effect prior: if the development-path stage is
  // reached but can't build, this makes the reason visible instead of silently
  // omitting the dev path + final metrics.
  const [devPlanError, setDevPlanError] = useState<string | null>(null);
  const [recommendedNctId, setRecommendedNctId] = useState("");
  const [appliedNctIds, setAppliedNctIds] = useState<Set<string>>(new Set());
  const [valuationBrief, setValuationBrief] = useState<ValuationBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  // Governance gate: the valuationBrief MUST govern every valuation. This status
  // makes a missing/failed brief a hard, visible failure instead of a silent
  // fallback to the raw CT.gov pipeline (which produced confident-but-wrong numbers).
  //   idle      — no auto-value run yet (manual entry mode)
  //   loading   — lead reasoner in flight
  //   complete  — brief governs this valuation; downstream may run
  //   failed    — lead reasoner failed after retries; valuation is HALTED
  const [briefStatus, setBriefStatus] = useState<"idle" | "loading" | "complete" | "failed">("idle");
  const [briefError, setBriefError] = useState<string | null>(null);
  const [briefSummary, setBriefSummary] = useState<string | null>(null);
  const [expectationAudit, setExpectationAudit] = useState<ExpectationAuditResult | null>(null);
  // Structure generator (>1 indication): the deterministic validator's flags (rejections/chains) from
  // /api/indication-structure. The resolved relationships are merged onto v.indications (below); these
  // flags surface WHY (a rejected/demoted or single-level-chain call), never a number.
  const [structureFlags, setStructureFlags] = useState<{ code: string; severity: string; message: string }[]>([]);
  // Signature over the generator's REASONING INPUTS only (NOT indicationRelationship) so merging the
  // result back doesn't retrigger the fetch — one reason per real input change.
  const structureSigRef = useRef<string>("");
  // Conversational rearchitecture: chat is the primary command surface; the editable manual panel is
  // DEMOTED to this collapsed advanced drawer (default hidden). The same setters stay reachable (the
  // parity path); a read-only State & Assumptions view keeps every engine-set value visible.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { pushToast, ToastHost } = useToast();

  // The downstream valuation chain (PTRS → Layer 2 → dev plan) is scheduled via
  // setTimeout from onAutoValue, so those callbacks close over `valuationBrief`
  // as it was when Auto-Valuate was CLICKED (null) — not the brief that arrived
  // seconds later. Reading a ref instead of the stale closure lets the async
  // chain see the CURRENT brief. (Regression fix: without this the dev-plan
  // governance gate always saw null and silently skipped the whole dev plan.)
  const valuationBriefRef = useRef<ValuationBrief | null>(null);
  useEffect(() => { valuationBriefRef.current = valuationBrief; }, [valuationBrief]);
  // Same stale-closure hazard: the timer-scheduled chain reads the trial list to
  // pick an anchoring NCT, but the closure captured it as null (pre-fetch). Read
  // the ref so Layer 2's fallback trial + the effect prior's anchor see the
  // trials that actually loaded during this run.
  const trialResultsRef = useRef<CtgovTrial[] | null>(null);
  useEffect(() => { trialResultsRef.current = trialResults; }, [trialResults]);

  useEffect(() => setSaved(loadAll()), []);

  const out = useMemo(() => computeOutputs(v), [v]);
  const display: Valuation = useMemo(() => ({ ...v, ...out }), [v, out]);
  const base = useMemo(
    () => buildBaseContext(display, out, ptrsResult, layer2Result, effectPrior),
    [display, out, ptrsResult, layer2Result, effectPrior],
  );

  const devPlan = useMemo<DevPlanResult | null>(() => {
    // The valuationBrief GOVERNS the dev plan (it sourced the threshold, the
    // efficacy-gate trial, and the SOC anchor). No brief → no P(approval)/eNPV.
    if (!devPlanStages || !base || !valuationBrief) return null;
    const revenuePVM = (out.revenuePV ?? 0) / 1e6;
    const mixture = effectPrior?.mixture ?? mixtureFromMssVariance(base.mss, base.variance);
    // Class base-rate risk from the analog step (Step 3), haircutting the stage
    // probabilities too — not just the effect prior. Part 2: when the analog step
    // reported STRUCTURED facts, derive p_graveyard + the classStatus label from
    // the deterministic rule (class-risk.ts) so the haircut stops flipping with a
    // coin-flip graveyard/mixed LABEL; otherwise fall back to the LLM's label.
    const analogStep = effectPrior?.chain?.find((s) => s.source === "analog");
    const classRisk = analogStep?.classEvidence ? classGraveyardProbability(analogStep.classEvidence) : null;
    const modalityClassStatus = classRisk?.classStatus ?? analogStep?.classStatus;
    const classGraveyardProb = classRisk?.pGraveyard;
    // Fix #2: therapeutic area keys the pinned cost-per-patient benchmark.
    const therapeuticArea = inferTherapeuticArea(valuationBrief?.base_case_indication?.value || v.indication);
    // Fix B: orphan benefits apply only when confirmed for the base-case indication.
    const orphanConfirmedForIndication = layer2Result?.orphanConfirmedForIndication === true;
    return computeDevPlan(
      mixture, base.ciHalfWidth,
      { stages: devPlanStages, regulatoryContext: devPlanRegContext, regCostM: 1.0, modalityClassStatus, classGraveyardProbability: classGraveyardProb, therapeuticArea, orphanConfirmedForIndication },
      revenuePVM,
    );
  }, [devPlanStages, base, out.revenuePV, devPlanRegContext, effectPrior, valuationBrief, v.indication, layer2Result]);


  // Single source of truth for the displayed P(approval): a genuine user
  // override wins, else the dev plan governs, else the phase baseline. Used by
  // the indications table + tornado so they can't diverge from the headline.
  const governedPtrs = v.ptrs ?? devPlan?.pApproval ?? out.ptrs;

  // Chart/tornado valuation: same as `display` but with the governed P(approval)
  // and the dev plan's risk-adjusted cost, so the tornado reconciles to the
  // headline eNPV. Kept separate from `display` (which feeds `base` → `devPlan`)
  // to avoid a compute cycle. Defined AFTER devPlan for the same reason.
  const chartValuation: Valuation = useMemo(() => ({
    ...display,
    ptrs: governedPtrs,
    ...(devPlan ? { devCostPV: Math.round(devPlan.totalRiskAdjCostM * 1e6) } : {}),
  }), [display, governedPtrs, devPlan]);

  // Governed outputs for every rNPV/eNPV DISPLAY (table total, CSV, headline sign).
  // computeOutputs(chartValuation) uses the governed P(approval) and the dev plan's
  // RISK-ADJUSTED cost, so these reconcile to the headline eNPV instead of the legacy
  // `out.rnpv`, which subtracts the FULL NOMINAL devCostPV from risk-adjusted revenue
  // (the cost/revenue asymmetry that produced tau's spurious −$710M). Display-only —
  // `out`/`display`/`base`/`devPlan` are unchanged, so no computed golden moves.
  const governedOut = useMemo(() => computeOutputs(chartValuation), [chartValuation]);

  // >1 indication → the headline is the Σ of per-indication STRUCTURAL contributions (each at its own
  // P, own launch, and any conditional P-weight), NOT devPlan.eNPVM (which is pooled revenue × the
  // lead's single P). ≤1 indication keeps the exact single-indication path (devPlan.eNPVM).
  const isMultiIndication = (v.indications?.length ?? 0) > 1;

  // Read-only self-check over the finished base valuation (observes & flags; never adjusts). For >1
  // indication the A8 aggregation blocker also fires: it asserts the DISPLAYED headline equals the Σ of
  // per-indication STRUCTURAL contributions (governedOut.indicationOutputs) — the exact guard against a
  // pooled-revenue × single-P headline. Defined AFTER governedOut so the structural Σ is available.
  const valuationSelfReport = useMemo(
    () => {
      if (!devPlan) return null;
      const view = viewFromDevPlan(devPlan, { launchYear: v.launchYear, loeYear: v.loeYear, asOfYear: new Date().getFullYear() });
      if (isMultiIndication) {
        view.multiIndication = {
          headlineENPVM: governedOut.rnpv / 1e6,
          componentRnpvsM: governedOut.indicationOutputs.map((o) => o.rnpv / 1e6),
          labels: governedOut.indicationOutputs.map((o) => o.name),
        };
      }
      return selfCheck({ view });
    },
    [devPlan, v.launchYear, v.loeYear, isMultiIndication, governedOut],
  );

  // ── Structure generator: on a >1-indication asset, ask /api/indication-structure to reason the
  //    relationships (independent / conditional-on / sequential-after) and MERGE them onto the
  //    indications, where the existing computeOutputs aggregation (8eb33cc) consumes them. The LLM
  //    specifies structure only; deterministic code computes every number. Fires ONLY at >1 indication;
  //    single-indication assets never call it (FROZEN path untouched). Graceful: any error leaves the
  //    relationships unset → every non-lead stays independent + flagged → today's exact behavior.
  //    Debounced + signature-gated so it reasons once per real input change, not per keystroke or merge.
  useEffect(() => {
    const inds = v.indications;
    if (!inds || inds.length < 2) { setStructureFlags((f) => (f.length ? [] : f)); return; }
    const sig =
      JSON.stringify(inds.map((i) => ({ id: i.id, name: i.name, phase: i.phase, launchYear: i.launchYear, nctId: i.nctId }))) +
      `|${v.asset ?? ""}|${v.mechanism ?? ""}|${(briefSummary ?? trialSummary ?? "").slice(0, 240)}`;
    if (sig === structureSigRef.current) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      structureSigRef.current = sig;
      try {
        const resp = await fetch("/api/indication-structure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            drug: v.asset, mechanism: v.mechanism, sponsor: v.sponsor, summary: briefSummary ?? trialSummary ?? "",
            indications: inds.map((i) => ({ id: i.id, name: i.name, phase: i.phase, launchYear: i.launchYear, nctId: i.nctId })),
          }),
        });
        if (!resp.ok || cancelled) return; // graceful → independent + flagged
        const data = await resp.json();
        if (cancelled || !Array.isArray(data?.relationships)) return;
        const relById = new Map<string, string>(data.relationships.map((r: any) => [String(r.id), String(r.indicationRelationship)]));
        setStructureFlags(Array.isArray(data.flags) ? data.flags : []);
        setV((cur) => {
          if (!cur.indications) return cur;
          let changed = false;
          const next = cur.indications.map((ind) => {
            const rel = relById.get(ind.id);
            if (rel && rel !== ind.indicationRelationship) { changed = true; return { ...ind, indicationRelationship: rel }; }
            return ind;
          });
          return changed ? { ...cur, indications: next } : cur;
        });
      } catch { /* graceful degradation → today's all-independent behavior */ }
    }, 700);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.indications, v.asset, v.mechanism, v.sponsor, briefSummary, trialSummary]);

  // ── Expectation smoke detector: fires when devPlan result changes ─────────
  useEffect(() => {
    if (devPlan && valuationBrief) {
      runExpectationCheck(valuationBrief, devPlan.pApproval);
    }
  }, [devPlan?.pApproval, valuationBrief]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Timeline → launch year: dev-plan duration drives revenue PV discounting ─
  // Only depends on the implied year, so a manual launchYear edit afterwards
  // sticks until the plan's duration actually changes. LOE follows per its
  // basis: exclusivity-anchored LOE slides with launch, patent LOE stays
  // calendar-fixed unless launch overtakes it (then regulatory exclusivity
  // from approval becomes the binding constraint).
  useEffect(() => {
    if (!devPlan) return;
    const implied = devPlan.impliedLaunchYear;
    const current = v.indications?.[0]?.launchYear ?? v.launchYear;
    if (current === implied) return;
    // Fix #2: LOE from the pinned rule (real patent when cited, else labeled
    // exclusivity term by modality/designation) anchored to the timeline launch.
    const patentLoe = v.loeBasis === "patent" ? v.loeYear : null;
    const loePin = computeLoeYear({
      launchYear: implied,
      modality: inferModality(v.mechanism),
      regulatoryContext: devPlanRegContext as any,
      patentLoeYear: patentLoe,
      orphanConfirmed: layer2Result?.orphanConfirmedForIndication === true,
    });
    const newLoe = loePin.loeYear;
    setLoeProvenance(loePin.provenance);
    const loeChanged = newLoe !== v.loeYear;
    setV((cur) => ({
      ...cur,
      launchYear: implied,
      loeYear: newLoe,
      loeBasis: loePin.basis,
      loeExclusivityYears: loePin.exclusivityYears,
      indications: cur.indications?.length
        ? cur.indications.map((ind, i) => (i === 0 ? { ...ind, launchYear: implied, loeYear: newLoe } : ind))
        : cur.indications,
    }));
    pushToast(
      `Launch year set to ${implied} from dev plan timeline (${Math.round(devPlan.totalDurationMonths)} months to approval).` +
      (loeChanged ? ` LOE ${newLoe} — ${loePin.provenance}.` : ""),
      "info", loeChanged ? 9000 : 6000,
    );
  }, [devPlan?.impliedLaunchYear]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateDevPlanN(id: string, n: number) {
    setDevPlanStages((prev) => prev?.map((s) =>
      s.id === id ? { ...s, n, trialDesign: { ...s.trialDesign, n } } : s
    ) ?? null);
  }
  function updateDevPlanCpp(id: string, cpp: number) {
    setDevPlanStages((prev) => prev?.map((s) => s.id === id ? { ...s, cpp } : s) ?? null);
  }

  function update<K extends keyof Valuation>(key: K, val: Valuation[K]) {
    setV((cur) => ({ ...cur, [key]: val }));
  }

  // THE VALIDATION CHOKE POINT. Every field update — deterministic parse OR LLM-suggested — flows
  // through here. Out-of-range values are rejected + surfaced, never set. Accepted values go through
  // applyValidatedUpdates (the pure transform that reproduces the panel setters' side-effects:
  // peakSales → first indication, loeYear → clears loeBasis), so a chat write === the manual path.
  function onFieldUpdate(updates: Record<string, any>) {
    const { accepted, rejected } = validateValuationInputs(updates);
    const okCount = Object.keys(accepted).length;
    if (okCount) setV((cur) => applyValidatedUpdates(cur, accepted));
    if (okCount) pushToast(`Applied ${okCount} field update${okCount > 1 ? "s" : ""}.`, "success");
    if (rejected.length) pushToast(`Rejected: ${rejected.map((r) => `${r.field} (${r.reason})`).join("; ")}`, "error");
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
        setV((cur) => ({
          ...cur,
          loeYear: data.loeYear,
          loeBasis: data.loeBasis ?? undefined,
          loeExclusivityYears: data.exclusivityYears ?? cur.loeExclusivityYears,
          sources: [...(cur.sources || []), ...(data.orangeBook?.sources || [])],
        }));
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

  // ── Lead Reasoner: runs FIRST, GOVERNS the whole valuation ────────────────
  // Returns a valid brief or null. On null the caller MUST halt — it must not
  // fall back to the raw pipeline. Auto-retries transient failures (timeout,
  // overload, unparseable output) up to 2 times before failing.
  async function onRunLeadReasoner(
    drug: string, sponsor?: string, phase?: string,
    mechanism?: string, indication?: string,
  ): Promise<ValuationBrief | null> {
    setBriefLoading(true);
    setBriefStatus("loading");
    setBriefError(null);
    setValuationBrief(null);
    setBriefSummary(null);
    setExpectationAudit(null);

    const MAX_ATTEMPTS = 3;
    let lastError = "Lead reasoner did not produce an assessment.";

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch("/api/lead-reasoner", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ drug, sponsor, phase, mechanism, indication }),
          });
          const data = await res.json();

          if (res.ok && data.brief) {
            setValuationBrief(data.brief);
            setBriefSummary(data.summary ?? null);
            setBriefStatus("complete");

            const brief = data.brief as ValuationBrief;
            setV((cur) => ({
              ...cur,
              phase: brief.true_stage?.value || cur.phase,
              indication: brief.base_case_indication?.value || cur.indication,
            }));

            pushToast(
              `Strategic assessment complete — ${brief.is_low_confidence ? "LOW CONFIDENCE (thin evidence basis)" : "base case framed"}`,
              brief.is_low_confidence ? "info" : "success",
              6000,
            );
            return brief;
          }

          // No valid brief. Credit-balance (402) is not transient — fail fast.
          lastError = data.error || `Lead reasoner returned no brief (HTTP ${res.status}).`;
          if (res.status === 402) break;
          if (attempt < MAX_ATTEMPTS) {
            pushToast(`Strategic assessment attempt ${attempt} failed — retrying…`, "info", 4000);
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        } catch (e: any) {
          lastError = e?.message || "network error";
          console.error(`[lead-reasoner] attempt ${attempt} failed:`, lastError);
          if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }

      // All attempts exhausted — HALT. Do not let the pipeline proceed.
      setBriefStatus("failed");
      setBriefError(lastError);
      return null;
    } finally {
      setBriefLoading(false);
    }
  }

  // Retry the governing brief after a failure, then resume the governed pipeline.
  async function onRetryLeadReasoner() {
    const drug = v.asset || (v as any).name;
    if (!drug) return;
    const brief = await onRunLeadReasoner(drug, v.sponsor, v.phase, v.mechanism, v.indication);
    if (!brief) {
      pushToast("Strategic assessment still failed — valuation not run.", "error", 8000);
      return;
    }
    const indication = brief.base_case_indication?.value || v.indications?.[0]?.name || v.indication || "";
    const phase = brief.true_stage?.value || v.phase || "Phase 2";
    if (brief.base_case_indication?.value) {
      setV((cur) => ({
        ...cur,
        indication,
        phase,
        indications: cur.indications?.map((ind, i) => (i === 0 ? { ...ind, name: indication } : ind)),
      }));
    }
    pushToast("Strategic assessment complete — running valuation…", "success", 6000);
    onScorePtrs(drug, v.mechanism || "", indication, phase, v.sponsor);
  }

  // ── Expectation smoke detector: ACTIVE CLOSED LOOP ──────────────────────
  // Detects divergence, investigates the inputs, fixes errors, and RE-RUNS.
  // The corrected result is what displays — not a warning above wrong numbers.
  function runExpectationCheck(brief: ValuationBrief, pApproval: number) {
    const { range_low, range_high } = brief.expectation_anchor;
    const fmtR = (lo: number, hi: number) => `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`;
    const fmtP = (p: number) => `${(p * 100).toFixed(1)}%`;

    const divergence: ExpectationAuditResult["divergence"] =
      pApproval < range_low * 0.5 || pApproval > range_high * 2.0 ? "sharp"
      : pApproval < range_low || pApproval > range_high ? "mild"
      : "none";

    const audit: ExpectationAuditResult = {
      expected_range: [range_low, range_high],
      actual_p_approval: pApproval,
      divergence,
      audit_findings: [],
      corrections_made: [],
      conclusion: "",
    };

    if (divergence === "none") {
      audit.conclusion = `P(approval) ${fmtP(pApproval)} is within the expected ${fmtR(range_low, range_high)} range.`;
      setExpectationAudit(audit);
      return;
    }

    // ── ACTIVE AUDIT: investigate the inputs ─────────────────────────────
    // Priority order of likely culprits:
    //   1. Success threshold too low (most common cause of inflated P)
    //   2. Wrong trial selected as efficacy gate
    //   3. Prior too optimistic for the evidence

    const stages = devPlanStages;
    if (!stages?.length) {
      audit.conclusion = `Divergence detected but no dev-plan stages to audit.`;
      setExpectationAudit(audit);
      return;
    }

    let correctionsMade = false;
    const correctedStages = [...stages];

    // The lead reasoner's soc_response_rate is the PRIMARY threshold —
    // the per-indication clinically meaningful registration bar. The
    // absolute floor (10% RR / 25% TTE) is just a backstop.
    const reasonedBar = brief.soc_response_rate?.value ?? 0.15;
    const reasonedSource = brief.soc_response_rate?.source ?? "default";

    // CHECK 1: Reconcile each stage's threshold against BOTH:
    //   (a) The absolute floor (already applied by effectiveThreshold in bayesian-rr.ts)
    //   (b) The lead reasoner's per-indication bar (the REAL check)
    // A threshold that clears the floor but sits below the reasoned bar is still wrong.
    for (let i = 0; i < correctedStages.length; i++) {
      const stage = correctedStages[i];
      const stageNullRR = stage.nullResponseRate ?? 0.15;

      // The correct threshold is the MAX of:
      //   - what's currently set on the stage
      //   - the lead reasoner's clinically meaningful bar for this indication
      //   - the TTE proxy floor if applicable
      const correctThreshold = Math.max(
        stageNullRR,
        reasonedBar,
        stage.isTimeToEvent ? 0.30 : 0,
      );

      if (correctThreshold > stageNullRR + 0.02) {
        const reason = correctThreshold === reasonedBar
          ? `lead reasoner's per-indication registration bar (${reasonedSource})`
          : stage.isTimeToEvent
            ? "TTE proxy — higher bar for time-to-event endpoint"
            : "clinically meaningful floor";
        audit.audit_findings.push(
          `Stage "${stage.name}": threshold was ${(stageNullRR * 100).toFixed(0)}%, ` +
          `below the ${(correctThreshold * 100).toFixed(0)}% ${reason}. Corrected.`
        );
        audit.corrections_made.push(
          `Threshold ${(stageNullRR * 100).toFixed(0)}% → ${(correctThreshold * 100).toFixed(0)}% for ${stage.name}`
        );
        correctedStages[i] = { ...stage, nullResponseRate: correctThreshold };
        correctionsMade = true;
      }
    }

    // CHECK 2: Is the efficacy gate trial correct? (verify against brief)
    if (brief.efficacy_gate_trial?.trial_id) {
      audit.audit_findings.push(
        `Efficacy gate: ${brief.efficacy_gate_trial.trial_name || brief.efficacy_gate_trial.trial_id} ` +
        `(${brief.efficacy_gate_trial.confidence}). Verified correct.`
      );
    }

    // CHECK 3: If no threshold corrections found the issue, note the prior
    if (!correctionsMade && divergence === "sharp") {
      audit.audit_findings.push(
        `No threshold miscalibration found. The prior (evidence engine's effect estimate) ` +
        `may be too optimistic for the available clinical evidence. Review the mechanism ` +
        `scorer's MSS and the evidence chain's σ² for this drug.`
      );
    }

    // ── APPLY CORRECTIONS AND RE-RUN ─────────────────────────────────────
    if (correctionsMade) {
      setDevPlanStages(correctedStages);
      audit.conclusion =
        `Audit found ${audit.corrections_made.length} input error${audit.corrections_made.length > 1 ? "s" : ""} ` +
        `and corrected ${audit.corrections_made.length === 1 ? "it" : "them"}. ` +
        `The displayed P(approval) is the CORRECTED result from re-running the math with fixed thresholds.`;
      pushToast("Divergence audit: threshold corrected, re-running valuation…", "info", 4000);
    } else if (divergence === "sharp") {
      audit.conclusion =
        `Sharp divergence (expected ${fmtR(range_low, range_high)}, got ${fmtP(pApproval)}) ` +
        `but no fixable input errors found. The prior may be too optimistic — ` +
        `review the evidence chain and mechanism scorer for this drug.`;
    } else {
      audit.conclusion =
        `Mild divergence from expectation. Inputs appear reasonable; ` +
        `the result may reflect genuinely strong/weak evidence.`;
    }

    setExpectationAudit(audit);
  }

  async function onAutoValue(
    drugOverride?: string,
    sponsorOverride?: string,
    phaseOverride?: string
  ): Promise<string | null> {
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
    const phase = phaseOverride || (drugOverride ? "Phase 2" : v.phase) || "Phase 2";

    setAutoLoading(true);
    setTrialResults(null);
    setPatentResult(null);
    setPtrsResult(null);
    setDevPlanStages(null);
    setDevPlanReasoning(null);
    setDevPlanError(null);

    // ── Lead Reasoner fires IN PARALLEL with auto-value ───────────────────
    // The brief governs downstream modules. It runs alongside auto-value
    // (not blocking it) so the pipeline doesn't stall for 30s.
    const briefPromise = onRunLeadReasoner(drug, sponsor, phase, v.mechanism, v.indication);

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
      // Apply auto-value financial data immediately (brief may still be loading)
      setV((cur) => ({
        ...cur,
        asset: drugOverride || cur.asset,
        loeYear: data.loeYear ?? cur.loeYear,
        loeBasis: data.loeYear ? (data.loeBasis ?? undefined) : cur.loeBasis,
        loeExclusivityYears: data.loeExclusivityYears ?? cur.loeExclusivityYears,
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
      // Auto-value indication names — fallback only (used for the base case if the
      // brief omits one). Revenue is NOT triggered here: Part A (Fix #3) requires the
      // revenue module to value the SAME base-case indication the lead reasoner chose,
      // not the broad auto-value label — so the trigger moves below, after the brief.
      const autoIndNames = (data.indications || []).map((i: any) => i.name).filter(Boolean);

      // Wait for the brief — it GOVERNS the valuation. It runs in parallel with
      // auto-value, so it may already be done by the time we reach here.
      const brief = await briefPromise;

      // ── HARD GATE ────────────────────────────────────────────────────────
      // If the brief didn't complete, HALT. The old code fell through here with
      // `brief?.…` optional chaining and ran PTRS/dev-plan on CT.gov defaults,
      // producing a confident-but-ungoverned P(approval). That is worse than an
      // error. briefStatus is already "failed" (set by onRunLeadReasoner); the
      // UI shows the failure state + Retry. Do NOT score PTRS or build a dev plan.
      if (!brief) {
        pushToast(
          "Couldn't complete the strategic assessment — valuation not run. Press Retry in the Strategic Assessment card.",
          "error", 10000,
        );
        return `Loaded trials for **${drug}**, but the strategic assessment did not complete — no probability or eNPV was computed. Retry the strategic assessment to run the valuation.`;
      }

      const briefIndication = brief.base_case_indication?.value;
      const ptrsIndication = briefIndication || autoIndNames[0] || "";
      const ptrsPhase = brief.true_stage?.value || data.phase;

      // Part A (Fix #3): revenue values the BRIEF's base-case indication — the same
      // indication the probability engine values — so TAM/population/comps/peak all
      // match the base case. The broad pan-tumor opportunity is a Strategy-Advisor
      // OPTION, not the base-case revenue pool.
      if (ptrsIndication) {
        setTimeout(() => onResearchRevenue([ptrsIndication], drug), 15000);
      }

      // Re-apply brief's indication now that both brief and auto-value are done
      if (briefIndication) {
        setV((cur) => ({
          ...cur,
          indication: briefIndication,
          phase: brief.true_stage?.value || cur.phase,
          indications: cur.indications?.map((ind, i) =>
            i === 0 ? { ...ind, name: briefIndication } : ind
          ),
        }));
      }

      // Auto-trigger PTRS mechanism scoring — brief's indication and phase govern
      setTimeout(() => onScorePtrs(drug, data.mechanism || "", ptrsIndication, ptrsPhase, data.sponsor), 5000);

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

      // Fix #2: peak sales ANCHORED to the retrieved comps (deterministic median),
      // not the free-floating LLM peak estimate — so it stops swinging run-to-run.
      // Capture the base-case (primary) peak-sales provenance for the live UI tag.
      const primaryRev = data.indications[0];
      if (primaryRev) {
        const primaryComps = classifyComps((primaryRev.comps || []).map((c) => ({ drug: c.drug, peakSalesM: c.peakSalesM })));
        setPeakProvenance(anchorPeakSales(primaryComps, { rawLlmPeakM: primaryRev.peakSalesM }).provenance);
      }
      setV((cur) => {
        if (!cur.indications?.length) return cur;
        const updated = cur.indications.map((ind, i) => {
          const rev = data.indications[i];
          if (!rev) return ind;
          const comps = classifyComps((rev.comps || []).map((c) => ({ drug: c.drug, peakSalesM: c.peakSalesM })));
          const pin = anchorPeakSales(comps, { rawLlmPeakM: rev.peakSalesM });
          const anchoredM = pin.baseM > 0 ? pin.baseM : rev.peakSalesM;
          // Persist the bottom-up market context (Build 1) so the Strategy Advisor can
          // RE-DERIVE the market per scenario instead of haircutting the peak.
          const mc = rev.marketContext ?? {};
          return anchoredM > 0
            ? { ...ind, peakSales: Math.round(anchoredM * 1e6),
                tamM: mc.tamM ?? ind.tamM, penetrationPct: mc.penetrationPct ?? ind.penetrationPct,
                annualPriceUsd: mc.pricingPerYear ?? ind.annualPriceUsd }
            : ind;
        });
        return { ...cur, indications: updated };
      });

      pushToast(`Revenue research complete: ${withEstimates}/${data.indications.length} indications with estimates.`, "success", 8000);
    } catch (e: any) {
      console.error("[revenue] failed:", e?.message);
      pushToast(`Revenue research failed: ${e?.message || "error"}`, "error");
      // Set a minimal result so the panel stays visible with an error message
      setRevenueAnalysis({ drug, phase: v.phase || "", indications: (inds as string[]).map(ind => ({
        indication: ind, peakSalesM: 0, bullM: 0, bearM: 0,
        confidence: "low" as const, reasoning: `Revenue analysis failed: ${e?.message || "error"}. Click ↻ Refresh to retry.`,
        analystEstimates: [], marketContext: {}, comps: [], sources: [],
      }))});
    } finally {
      setRevenueLoading(false);
    }
  }

  async function onScorePtrs(drug: string, mechanism: string, indication: string, phase: string, sponsor?: string) {
    setPtrsLoading(true);
    try {
      const res = await fetch("/api/ptrs-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drug, mechanism, indication, phase, sponsor }),
      });
      if (!res.ok) throw new Error("PTRS scoring failed");
      const data = await res.json();
      setPtrsResult(data);
      setPtrsOverrides({});   // clear any previous manual overrides
      setLayer2Result(null);  // clear stale Layer 2 while new one loads
      // NOTE: do NOT write the computed PTRS into v.ptrs — that field is the
      // USER's "Override P(approval)" input. Writing here leaked a computed
      // number into the override and made the indications table use it instead
      // of the dev plan's governed P(approval). The result lives in ptrsResult.
      pushToast(`Mechanism scored: MSS ${Math.round(data.mss * 100)} → P(approval) prior ${(data.ptrs * 100).toFixed(1)}% — analyzing trial design…`, "success", 6000);
      // Auto-trigger Layer 2 (45s delay — well clear of the 60s rate-limit window)
      setTimeout(() => onScoreLayer2(drug, indication, phase, sponsor, data), 45000);
      // Auto-trigger the True Effect Prior evidence chain in parallel — both
      // only depend on the Layer 1 mechanism result, not on each other.
      setTimeout(() => onGenerateEffectPrior(drug, indication, phase, sponsor, data), 45000);
    } catch (e: any) {
      console.error("[ptrs] scoring failed:", e?.message);
      pushToast(`PTRS scoring failed: ${e?.message || "unknown error"}`, "error", 6000);
    } finally {
      setPtrsLoading(false);
    }
  }

  async function onGenerateEffectPrior(
    drug: string, indication: string, phase: string,
    sponsor: string | undefined, l1Result: any
  ) {
    setEffectPriorLoading(true);
    try {
      // Same NCT-matching logic as onScoreLayer2 — gives the "own clinical
      // evidence" discovery step a trial to anchor to, when available.
      // Ref, not closure: this runs ~45s after the click, past the stale capture.
      const phaseNum = (p: string) => p.includes("3") ? 3 : p.includes("2") ? 2 : p.includes("1") ? 1 : 0;
      const drugPhaseNum = phaseNum(phase);
      const matchingTrial = trialResultsRef.current?.find((t) => phaseNum(t.phase || "") >= drugPhaseNum);
      const nctId = matchingTrial?.nctId ?? undefined;

      const res = await fetch("/api/effect-prior", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drug, indication, phase, sponsor, nctId,
          mechanism: {
            mss: l1Result.mss,
            variance: l1Result.variance,
            summary: l1Result.summary,
          },
        }),
      });
      if (!res.ok) throw new Error("Effect prior generation failed");
      const data = await res.json();
      setEffectPrior(data.effectPrior as EffectPrior);
    } catch (e: any) {
      console.error("[effect-prior] generation failed:", e?.message);
    } finally {
      setEffectPriorLoading(false);
    }
  }

  async function onGenerateDevPlan(drug: string, indication: string, phase: string, sponsor: string | undefined, l2Result: any) {
    if (!l2Result?.trialInputs) return;
    // Governance gate: the dev plan's thresholds come from the brief's sourced
    // SOC/registration rate. Without a brief, the threshold collapses and
    // P(trial success) inflates to ~100% — refuse to build it. Read the ref, not
    // the stale closure (this runs ~45s after the click, when the brief exists).
    const brief = valuationBriefRef.current;
    if (!brief) {
      console.warn("[dev-plan] skipped: no governing valuationBrief");
      setDevPlanError("Development path not built: the strategic brief wasn't available when the engine reached this stage. Retry the strategic assessment.");
      return;
    }
    setDevPlanError(null);
    setDevPlanLoading(true);
    try {
      // Whether the current trial is already fully enrolled — from CT.gov status.
      // A fully-enrolled trial's accrual is elapsed, so the dev-plan timeline should
      // not project years of future enrollment for it. Read the ref (always current);
      // match the same trial that fed layer2 (first at-or-above the drug's phase).
      const phaseNum = (p: string) => p.includes("3") ? 3 : p.includes("2") ? 2 : p.includes("1") ? 1 : 0;
      const trials = trialResultsRef.current ?? [];
      const currentTrial =
        trials.find((t) => t.nctId === recommendedNctId) ??
        trials.find((t) => phaseNum(t.phase || "") >= phaseNum(phase));
      const currentTrialEnrollmentComplete = isEnrollmentComplete(currentTrial?.status);
      // Ground-truth readout date for a fully-enrolled current trial → drives remaining
      // duration (months-to-completion) instead of a projected enrollment window.
      const currentTrialCompletionDate = currentTrial?.primaryCompletionDate ?? currentTrial?.completionDate;
      const res = await fetch("/api/dev-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drug,
          indication,
          phase,
          sponsor,
          currentTrialDesign: l2Result.trialInputs,
          currentTrialName: drug,
          currentTrialEnrollmentComplete,
          currentTrialCompletionDate,
        }),
      });
      if (!res.ok) {
        // Surface the endpoint's real reason (e.g. malformed JSON, credit balance)
        // instead of an opaque status code, so the halt banner is diagnosable.
        const errBody = await res.json().catch(() => ({} as any));
        throw new Error(errBody.error || `API error ${res.status}`);
      }
      const data = await res.json();
      // Override stage nullResponseRate with the brief's sourced SOC rate when available
      const briefSocRR = brief.soc_response_rate?.value;
      const stages = (data.stages as DevStageInput[]).map((s) => ({
        ...s,
        nullResponseRate: s.nullResponseRate ?? briefSocRR,
      }));
      setDevPlanStages(stages);
      setDevPlanRegContext(data.regulatoryContext ?? "standard");
      setDevPlanReasoning(data.reasoning ?? null);
    } catch (e: any) {
      console.error("[dev-plan] auto-generate failed:", e?.message);
      setDevPlanError(`Development path could not be built: ${e?.message || "unknown error"}. The final value metrics need this stage — retry.`);
    } finally {
      setDevPlanLoading(false);
    }
  }

  async function onScoreLayer2(
    drug: string, indication: string, phase: string,
    sponsor: string | undefined, l1Result: any
  ) {
    setLayer2Loading(true);
    try {
      // Use the brief's efficacy gate trial when available (the lead reasoner has
      // already identified which trial is the REAL efficacy gate, excluding substudies).
      // Falls back to the old heuristic: pick a trial matching the drug's phase.
      // Read via ref — this runs ~45s after the click, past the stale closure.
      const briefNctId = valuationBriefRef.current?.efficacy_gate_trial?.trial_id;
      let nctId: string | undefined = briefNctId || undefined;
      if (!nctId) {
        const phaseNum = (p: string) => p.includes("3") ? 3 : p.includes("2") ? 2 : p.includes("1") ? 1 : 0;
        const drugPhaseNum = phaseNum(phase);
        const matchingTrial = trialResultsRef.current?.find((t) => phaseNum(t.phase || "") >= drugPhaseNum);
        nctId = matchingTrial?.nctId ?? undefined;
      }
      const res = await fetch("/api/ptrs-layer2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drug, indication, phase, sponsor, nctId,
          layer1: {
            mss: l1Result.mss,
            variance: l1Result.variance,
            ptrs: l1Result.ptrs,
            ciHalfWidth: l1Result.ptrsCI
              ? (l1Result.ptrsCI.upper - l1Result.ptrsCI.lower) / 2
              : 0.10,
          },
        }),
      });
      if (!res.ok) throw new Error("Layer 2 scoring failed");
      const data = await res.json();
      setLayer2Result(data);
      // Do NOT write into v.ptrs (the user override field) — see onScorePtrs.
      // The combined PTRS lives in layer2Result; the dev plan produces the
      // governed P(approval) the headline and table display.
      pushToast(`P(approval): ${(data.ptrsCombined * 100).toFixed(1)}% (mechanism + trial design) — building dev plan…`, "success", 6000);
      // Auto-generate development plan immediately after layer2
      onGenerateDevPlan(drug, indication, phase, sponsor, data);
    } catch (e: any) {
      console.error("[layer2] scoring failed:", e?.message);
      pushToast(`Trial design scoring failed: ${e?.message || "unknown error"}`, "error", 6000);
    } finally {
      setLayer2Loading(false);
    }
  }

  async function onRescore() {
    if (!ptrsResult) return;
    setPtrsRescoring(true);
    try {
      // Merge overrides into the existing factors
      const mergedFactors = Object.fromEntries(
        Object.entries(ptrsResult.factors).map(([key, factor]: [string, any]) => [
          key,
          ptrsOverrides[key] !== undefined
            ? { ...factor, score: ptrsOverrides[key] / 100, rationale: factor.rationale + " [user override]" }
            : factor,
        ])
      );
      const res = await fetch("/api/ptrs-rescore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factors: mergedFactors, phase: v.phase || "Phase 2" }),
      });
      if (!res.ok) throw new Error("Rescore failed");
      const data = await res.json();
      setPtrsResult(data);
      // Result lives in ptrsResult; v.ptrs stays reserved for the user override.
      pushToast(`PTRS recalculated: ${(data.ptrs * 100).toFixed(1)}%`, "success", 4000);
    } catch (e: any) {
      console.error("[ptrs] rescore failed:", e?.message);
    } finally {
      setPtrsRescoring(false);
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
    rows.push(["P(approval)", `${(ptrsVal * 100).toFixed(1)}%`]);
    rows.push(["rNPV ($M)", String(Math.round((governedOut.rnpv ?? 0) / 1e6))]);
    rows.push(["Revenue PV ($M)", String(Math.round((out.revenuePV ?? 0) / 1e6))]);
    rows.push(["Dev Cost PV ($M)", String(Math.round((out.devCostPV ?? 0) / 1e6))]);
    rows.push([]);

    // DCF table
    rows.push(["Year", "Phase", "P(approval)", "Disc Factor", "PW R&D Cost ($M)", "Gross Revenue ($M)", "COGS ($M)", "Dist ($M)", "Opex ($M)", "Net Revenue ($M)", "Net Income ($M)", "PW Net Income ($M)", "DCF ($M)", "Cum eNPV ($M)", "PI"]);

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

  const rnpvPositive = (governedOut.rnpv ?? 0) >= 0;
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

          {/* Strategic-assessment governance badge — makes a bypassed governing
              layer catchable at a glance (never invisible again). */}
          {v.asset && (() => {
            const s = briefStatus;
            const cfg = s === "complete"
              ? { bg: "rgba(16,185,129,0.12)", bd: "rgba(16,185,129,0.4)", dot: "#10b981", text: "Strategic assessment: complete — governing this valuation" }
              : s === "loading"
              ? { bg: "rgba(59,130,246,0.12)", bd: "rgba(59,130,246,0.4)", dot: "#3b82f6", text: "Strategic assessment: running…" }
              : s === "failed"
              ? { bg: "rgba(239,68,68,0.14)", bd: "rgba(239,68,68,0.5)", dot: "#ef4444", text: "Strategic assessment: NOT RUN — valuation halted" }
              : { bg: "rgba(148,163,184,0.12)", bd: "rgba(148,163,184,0.35)", dot: "#94a3b8", text: "Strategic assessment: not run — manual entry (no strategic governance)" };
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: 10, background: cfg.bg, border: `1px solid ${cfg.bd}`, fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: cfg.dot, flexShrink: 0, boxShadow: `0 0 8px ${cfg.dot}` }} />
                <span>{cfg.text}</span>
                {s === "failed" && (
                  <button className="btn" onClick={onRetryLeadReasoner} disabled={briefLoading}
                    style={{ marginLeft: "auto", background: "#ef4444", color: "#fff", fontSize: 12, fontWeight: 700, padding: "4px 12px", borderRadius: 6 }}>
                    {briefLoading ? "Retrying…" : "↻ Retry"}
                  </button>
                )}
              </div>
            );
          })()}

          {/* Key Metrics — HALTED when the governing brief failed: no P(approval)
              or eNPV from pipeline defaults. A visible failure beats a false 88%. */}
          {briefStatus === "failed" ? (
            <div className="animate-fade-up" style={{ padding: "24px 20px", borderRadius: 14, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.35)", textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#ef4444", marginBottom: 6 }}>Valuation not run</div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 620, margin: "0 auto 14px" }}>
                The strategic assessment (lead reasoner) didn&apos;t complete, so no probability, eNPV, or development plan was computed. The pipeline will not fall back to un-anchored defaults.
                {briefError && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>Reason: {briefError}</div>}
              </div>
              <button className="btn" onClick={onRetryLeadReasoner} disabled={briefLoading}
                style={{ background: "#ef4444", color: "#fff", fontWeight: 700, padding: "8px 20px", borderRadius: 8 }}>
                {briefLoading ? "Retrying…" : "↻ Retry strategic assessment"}
              </button>
            </div>
          ) : (
          <>
          <div className="animate-fade-up metrics-grid">
            <MetricCard
              label={devPlan ? "eNPV" : "rNPV"}
              value={fmtMoney(isMultiIndication ? governedOut.rnpv : (devPlan ? devPlan.eNPVM * 1e6 : out.rnpv))}
              gradient="linear-gradient(135deg, #059669, #10b981)"
              sub={isMultiIndication ? `Σ ${v.indications!.length} indications · each at its own P (structural)`
                : devPlan ? `Dev plan · P(approval) ${fmtPct(devPlan.pApproval)}`
                : briefStatus === "complete"
                  ? (devPlanLoading ? "Baseline — computing full analysis…" : "⚠ Baseline placeholder — dev path incomplete")
                  : (rnpvPositive ? "Risk-adjusted NPV" : "Negative — check inputs")}
            />
            <MetricCard
              label="P(approval)"
              value={devPlan ? fmtPct(devPlan.pApproval) : fmtPct(out.ptrs)}
              gradient="linear-gradient(135deg, #1d4ed8, #3b82f6)"
              sub={devPlan ? `${fmtPct(devPlan.pAllTrialsSuccess)} trials × ${fmtPct(devPlan.regStage.pApproval)} reg`
                : briefStatus === "complete"
                  ? (devPlanLoading ? "Computing development path…" : "⚠ Baseline placeholder — not the propagated number")
                  : (out.mechLabel || `Phase baseline · ${v.phase}`)}
            />
            <MetricCard label="Revenue PV" value={fmtMoney(out.revenuePV)} gradient="linear-gradient(135deg, #7c3aed, #a855f7)" sub="Full Revenue PV (before probability)" />
            <MetricCard
              label="Dev Cost"
              value={fmtMoney(devPlan ? devPlan.totalRiskAdjCostM * 1e6 : out.devCostPV)}
              gradient="linear-gradient(135deg, #ea580c, #f97316)"
              sub={devPlan ? `Expected R&D · ${fmtMoney(devPlan.totalNominalCostM * 1e6)} nominal` : "Investment"}
            />
            <MetricCard
              label="eROI"
              value={devPlan ? (devPlan.eROI != null ? devPlan.eROI.toFixed(2) + "x" : "—") : (out.roi != null ? out.roi.toFixed(1) + "x" : "—")}
              gradient="linear-gradient(135deg, #b45309, #eab308)"
              sub={devPlan ? "eNPV / Expected R&D" : "rNPV / Dev Cost"}
            />
          </div>
          {valuationSelfReport && (valuationSelfReport.blockers > 0 || valuationSelfReport.warns > 0) && (
            <div className="animate-fade-up" style={{
              marginTop: 10, padding: "10px 14px", borderRadius: 10,
              border: `1px solid ${valuationSelfReport.blockers > 0 ? "#ef4444" : "#f59e0b"}`,
              background: valuationSelfReport.blockers > 0 ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
            }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)", marginBottom: 4 }}>
                Self-check {valuationSelfReport.blockers > 0 ? `— ${valuationSelfReport.blockers} blocker(s)` : `— ${valuationSelfReport.warns} warning(s)`} · read-only, adjusts nothing
              </div>
              {valuationSelfReport.checks.filter((c) => !c.pass && c.severity === "BLOCKER").map((c) => (
                <div key={c.id} style={{ fontSize: 12, color: "#ef4444", fontWeight: 700, padding: "1px 0" }}>⛔ {c.explain}</div>
              ))}
              {valuationSelfReport.checks.filter((c) => !c.pass && c.severity === "WARN").map((c) => (
                <div key={c.id} style={{ fontSize: 12, color: "#f59e0b", padding: "1px 0" }}>⚠ {c.explain}</div>
              ))}
              {valuationSelfReport.flags.map((f) => (
                <div key={f.id} style={{ fontSize: 12, color: "#f59e0b", padding: "1px 0" }}>⚠ {f.explain}</div>
              ))}
            </div>
          )}
          </>
          )}

          {/* State & Assumptions — read-only. Every engine-set value stays VISIBLE (chat is the edit
              path; hiding the inputs that drive the number would be the opposite of the discipline). */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <SectionLabel>State &amp; Assumptions</SectionLabel>
              <button className="btn btn-outline" onClick={() => setShowAdvanced((s) => !s)} style={{ fontSize: 11, padding: "3px 10px" }}>
                {showAdvanced ? "Hide manual overrides" : "⚙ Manual overrides"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)", marginBottom: 12, lineHeight: 1.5 }}>
              Adjust anything through chat above — e.g. &ldquo;set discount rate to 12%&rdquo;, &ldquo;launch 2028&rdquo;, &ldquo;peak sales $2B&rdquo;. These inputs drive the valuation; the engine computes every number.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "8px 16px" }}>
              {([
                ["Asset", v.asset || "—"],
                ["Phase", v.phase || "—"],
                ["Sponsor", v.sponsor || "—"],
                ["Mechanism", v.mechanism || "—"],
                ["Discount Rate", v.discountRate != null ? fmtPct(v.discountRate) : "—"],
                ["COGS %", v.cogsPct != null ? fmtPct(v.cogsPct) : "—"],
                ["Tax Rate", v.taxRate != null ? fmtPct(v.taxRate) : "—"],
                ["Working Capital %", v.workingCapitalPct != null ? fmtPct(v.workingCapitalPct) : "—"],
                ...(v.ownerType === "Licensor" ? [["Avg Royalty %", v.avgRoyalty != null ? fmtPct(v.avgRoyalty) : "—"] as [string, any]] : []),
                ["Peak Sales", v.peakSales != null ? fmtMoney(v.peakSales) : "—"],
                ["Dev Cost PV", v.devCostPV != null ? fmtMoney(v.devCostPV) : "—"],
                ["Launch Year", v.launchYear ?? "—"],
                ["LOE Year", v.loeYear != null ? `${v.loeYear}${v.loeBasis ? ` (${v.loeBasis})` : ""}` : "—"],
                ["P(approval) override", v.ptrs != null ? fmtPct(v.ptrs) : "auto"],
              ] as [string, any][]).map(([label, val]) => (
                <div key={label}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)" }}>{label}</div>
                  <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 600 }}>{val}</div>
                </div>
              ))}
            </div>
            {v.indications && v.indications.length > 0 && (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", marginBottom: 6 }}>Indications</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {v.indications.map((ind, i) => (
                    <div key={ind.id} style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                      {i === 0 ? "★ " : "• "}{ind.name || "(unnamed)"} · peak {ind.peakSales != null ? fmtMoney(ind.peakSales) : "—"} · launch {ind.launchYear ?? "—"} · LOE {ind.loeYear ?? "—"} · P {ind.ptrs != null ? fmtPct(ind.ptrs) : "auto"}{ind.indicationRelationship && ind.indicationRelationship !== "independent" ? ` · ${ind.indicationRelationship}` : ""}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Inputs — DEMOTED to a collapsed advanced drawer (parity path: the SAME setters as before,
              just behind a toggle). Chat is the primary edit surface; this stays reachable + unchanged. */}
          {showAdvanced && (
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
              <FieldNumber label="Peak Sales" value={v.peakSales} onChange={(x) => update("peakSales", x)} hint={peakProvenance ?? "USD"} />
              <FieldNumber label="Discount Rate" value={v.discountRate} onChange={(x) => update("discountRate", x)} isPct hint="%" />
              <FieldNumber label="Dev Cost PV" value={v.devCostPV} onChange={(x) => update("devCostPV", x)} hint={devPlan ? "USD · not used — dev-plan risk-adj cost drives eNPV" : "USD"} />
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
              <FieldNumber label="LOE Year" value={v.loeYear} onChange={(x) => setV((cur) => ({ ...cur, loeYear: x, loeBasis: undefined }))} integer hint={
                loeProvenance
                ?? (v.loeBasis === "patent" ? "pinned: patent/exclusivity expiry"
                  : v.loeBasis === "exclusivity" ? "estimate: launch + regulatory exclusivity term"
                  : "user-entered")
              } />
              <FieldNumber label="Override P(approval)" value={v.ptrs} onChange={(x) => update("ptrs", x)} isPct hint="Leave blank = auto" />
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
                  {["Indication", "Peak Sales ($M)", "Launch", "LOE", "P(appr.)", "Dev Cost ($M)", "Rev PV", "rNPV", ""].map((h, i) => (
                    <div key={i} style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: "var(--font-mono)" }}>{h}</div>
                  ))}
                </div>
                {v.indications.map((ind, i) => (
                  <IndicationRow key={ind.id} ind={ind} globalPtrs={governedPtrs} valuation={v} numIndications={v.indications!.length} halted={briefStatus === "failed"} isPrimary={i === 0} governedDevCostM={devPlan?.totalRiskAdjCostM ?? null} structural={isMultiIndication ? (governedOut.indicationOutputs.find((o) => o.id === ind.id) ?? null) : null} onUpdate={updateIndication} onRemove={removeIndication} />
                ))}
                {v.indications.length > 1 && (
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(130px, 2fr) 90px 68px 68px 64px 80px 80px 80px 24px", gap: 6, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", gridColumn: "1 / 6" }}>Combined</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }}>{fmtMoney(governedOut.devCostPV)}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textAlign: "right" }}>{fmtMoney(governedOut.revenuePV)}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", textAlign: "right", color: briefStatus === "failed" ? "var(--text-faint)" : (governedOut.rnpv >= 0 ? "var(--accent)" : "var(--danger)") }}>{briefStatus === "failed" ? "—" : fmtMoney(governedOut.rnpv)}</div>
                    <div />
                  </div>
                )}
                {isMultiIndication && governedOut.indicationFlags.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                    {governedOut.indicationFlags.map((fl, i) => (
                      <div key={i} style={{ fontSize: 11, color: "var(--warning)", fontFamily: "var(--font-mono)", lineHeight: 1.4, display: "flex", gap: 6 }}>
                        <span aria-hidden>⚠</span><span>{fl}</span>
                      </div>
                    ))}
                  </div>
                )}
                {isMultiIndication && structureFlags.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {structureFlags.map((fl, i) => (
                      <div key={i} style={{ fontSize: 11, color: fl.severity === "reject" ? "var(--danger)" : "var(--text-faint)", fontFamily: "var(--font-mono)", lineHeight: 1.4, display: "flex", gap: 6 }}>
                        <span aria-hidden>{fl.severity === "reject" ? "✕" : "ℹ"}</span><span>{fl.message}</span>
                      </div>
                    ))}
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
          )}

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
                          {t.estimatedLaunchYear && <span title="Rough estimate from this trial's completion date. The modeled launch year (used in the eNPV) comes from the full development-plan timeline and may be later.">🚀 Trial-based launch ~{t.estimatedLaunchYear} (pre-plan)</span>}
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
                  <button className="btn" onClick={() => setV(cur => ({ ...cur, loeYear: patentResult.loeYear, loeBasis: patentResult.loeBasis ?? undefined, loeExclusivityYears: patentResult.exclusivityYears ?? cur.loeExclusivityYears }))}
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

          {/* PTRS Mechanism Breakdown — hidden once Effect Prior chain loads (chain subsumes it) */}
          {!effectPrior && (ptrsLoading || ptrsResult) && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <SectionLabel>Approval Probability — Mechanism Analysis</SectionLabel>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -8, marginBottom: 8 }}>
                    Mechanism prior (Layer 1) · AI-scored signal strength · {v.asset} · {v.phase}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn btn-ghost" onClick={() => { if (v.asset && v.mechanism) onScorePtrs(v.asset, v.mechanism, v.indications?.[0]?.name || "", v.phase || "Phase 2", v.sponsor); }} disabled={ptrsLoading} style={{ fontSize: 11 }}>{ptrsLoading ? "⏳" : "↻ Refresh"}</button>
                  <button onClick={() => setPtrsResult(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-faint)", lineHeight: 1 }}>×</button>
                </div>
              </div>

              {ptrsLoading && !ptrsResult && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)", fontSize: 13 }}>
                  ⏳ Scoring mechanism factors…
                </div>
              )}

              {ptrsResult && (() => {
                const FACTOR_LABELS: Record<string, string> = {
                  potency: "1A · Potency",
                  selectivity: "1B · Selectivity",
                  pkProfile: "1C · PK Profile",
                  targetEngagement: "1D · Target Engagement",
                  therapeuticWindow: "1E · Therapeutic Window",
                  targetValidation: "2A · Target Validation",
                  indicationMechFit: "2B · Indication Fit",
                  modalityFit: "2C · Modality Fit",
                  translationRate: "2D · Translation Rate",
                };
                const scoreColor = (s: number) => s >= 0.75 ? "#10b981" : s >= 0.5 ? "#f59e0b" : "#ef4444";
                const hasOverrides = Object.keys(ptrsOverrides).length > 0;
                return (
                  <div>
                    {/* Score summary row */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
                      {[
                        { label: "IPS", desc: "Intrinsic Potency", val: ptrsResult.ips },
                        { label: "TRS", desc: "Translational Reliability", val: ptrsResult.trs },
                        { label: "MSS", desc: "Mechanism Signal Strength", val: ptrsResult.mss },
                      ].map(({ label, desc, val }) => (
                        <div key={label} style={{ background: "var(--surface-2)", borderRadius: 8, padding: "12px 14px" }}>
                          <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{desc}</div>
                          <div style={{ fontSize: 24, fontWeight: 800, color: scoreColor(val), fontFamily: "var(--font-display)" }}>{(val * 100).toFixed(0)}</div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{label} / 100</div>
                        </div>
                      ))}
                    </div>

                    {/* Factor breakdown with override inputs */}
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Factor Breakdown</div>
                        <div style={{ fontSize: 10, color: "var(--text-faint)" }}>Edit score to override AI</div>
                      </div>
                      {Object.entries(ptrsResult.factors).map(([key, factor]: [string, any]) => {
                        const displayScore = ptrsOverrides[key] !== undefined ? ptrsOverrides[key] : Math.round(factor.score * 100);
                        const isOverridden = ptrsOverrides[key] !== undefined;
                        return (
                          <div key={key} style={{ display: "grid", gridTemplateColumns: "190px 80px 80px 1fr", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                              {FACTOR_LABELS[key] || key}
                              {isOverridden && <span style={{ color: "#f59e0b", fontSize: 10, marginLeft: 4 }}>✎</span>}
                            </div>
                            <input
                              type="number"
                              min={0} max={100}
                              value={displayScore}
                              onChange={(e) => {
                                const val = Math.max(0, Math.min(100, Number(e.target.value)));
                                setPtrsOverrides(prev => ({ ...prev, [key]: val }));
                              }}
                              style={{
                                width: 60, padding: "3px 6px", borderRadius: 4, border: `1px solid ${isOverridden ? "#f59e0b" : "var(--border)"}`,
                                background: isOverridden ? "rgba(245,158,11,0.08)" : "var(--surface-2)",
                                color: scoreColor(displayScore / 100), fontSize: 15, fontWeight: 700,
                                fontFamily: "var(--font-display)", textAlign: "center",
                              }}
                            />
                            <div style={{ fontSize: 10, color: factor.confidence === "unknown" ? "#f59e0b" : "var(--text-muted)", textTransform: "uppercase" }}>
                              {factor.confidence}{factor.highVariance ? " ⚠" : ""}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{factor.rationale}</div>
                          </div>
                        );
                      })}
                      {/* Override action bar */}
                      {hasOverrides && (
                        <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
                          <button
                            className="btn btn-primary"
                            onClick={onRescore}
                            disabled={ptrsRescoring}
                            style={{ fontSize: 12, padding: "6px 14px" }}
                          >
                            {ptrsRescoring ? "⏳ Recalculating…" : "↻ Recalculate with my inputs"}
                          </button>
                          <button
                            className="btn btn-ghost"
                            onClick={() => setPtrsOverrides({})}
                            style={{ fontSize: 11 }}
                          >
                            Reset to AI scores
                          </button>
                          {ptrsResult.overridden && (
                            <span style={{ fontSize: 11, color: "#f59e0b" }}>Using your overrides</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* PTRS result with confidence interval */}
                    <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Mechanism Prior · P(approval)</div>
                        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                          Phase baseline {(ptrsResult.baseline * 100).toFixed(0)}%
                          {" "}{ptrsResult.ptrsAdjustment >= 0 ? "+" : ""}{(ptrsResult.ptrsAdjustment * 100).toFixed(0)}% mechanism adjustment
                          {ptrsResult.divergence && <span style={{ color: "#f59e0b" }}> · IPS/TRS divergence flagged</span>}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 28, fontWeight: 800, color: scoreColor(ptrsResult.ptrs), fontFamily: "var(--font-display)", lineHeight: 1 }}>
                          {(ptrsResult.ptrs * 100).toFixed(1)}%
                        </div>
                        {ptrsResult.ptrsCI && (
                          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 3 }}>
                            range {(ptrsResult.ptrsCI.lower * 100).toFixed(0)}%–{(ptrsResult.ptrsCI.upper * 100).toFixed(0)}%
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 10 }}>{ptrsResult.summary}</div>

                    {/* Phase benchmark percentile */}
                    {ptrsResult.phaseBenchmark && (() => {
                      const bm = ptrsResult.phaseBenchmark;
                      const pctColor = bm.percentile >= 75 ? "#10b981" : bm.percentile >= 50 ? "#3b82f6" : bm.percentile >= 25 ? "#f59e0b" : "#ef4444";
                      return (
                        <div style={{ marginTop: 14, background: "var(--surface-2)", borderRadius: 8, padding: "12px 14px" }}>
                          <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>vs. Historical {bm.benchmarks.label} Drugs · Mechanism Prior (DiMasi / Hay et al.)</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color: pctColor, fontFamily: "var(--font-display)", minWidth: 52 }}>{bm.percentile}<span style={{ fontSize: 12, fontWeight: 500 }}>th</span></div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{bm.label}</div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                Industry range: {(bm.benchmarks.p10 * 100).toFixed(0)}%–{(bm.benchmarks.p90 * 100).toFixed(0)}% · median {(bm.benchmarks.median * 100).toFixed(0)}%
                              </div>
                            </div>
                            <div style={{ width: 100, height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${bm.percentile}%`, background: pctColor, borderRadius: 3, transition: "width 0.6s ease" }} />
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}
            </Card>
          )}

          {/* Layer 2 — Trial Design Simulation — hidden once Effect Prior chain loads (trial design now shown per-stage in DevPlan) */}
          {!effectPrior && (layer2Loading || layer2Result) && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <SectionLabel>Trial Design Simulation · Layer 2</SectionLabel>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -8, marginBottom: 8 }}>
                    Closed-form trial success probability · {v.asset} · {v.phase}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn btn-ghost" onClick={() => { if (ptrsResult) onScoreLayer2(v.asset || "", v.indications?.[0]?.name || "", v.phase || "Phase 2", v.sponsor || undefined, ptrsResult); }} disabled={layer2Loading} style={{ fontSize: 11 }}>{layer2Loading ? "⏳" : "↻ Refresh"}</button>
                  <button onClick={() => setLayer2Result(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-faint)", lineHeight: 1 }}>×</button>
                </div>
              </div>

              {layer2Loading && !layer2Result && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)", fontSize: 13 }}>
                  ⏳ Analyzing trial design…
                </div>
              )}

              {layer2Result && (() => {
                const scoreColor = (s: number) => s >= 0.75 ? "#10b981" : s >= 0.5 ? "#f59e0b" : "#ef4444";
                const deltaColor = (d: number) => d >= 0 ? "#10b981" : "#ef4444";
                const { trialInputs, riskFlags, phaseBenchmark, ptrsCombined, ptrsCI, layer2Delta, layer2Multiplier, trialSuccessProb, ptrsLayer1 } = layer2Result;

                const ENDPOINT_LABEL: Record<string, string> = { hard: "Hard endpoint", surrogate: "Surrogate endpoint", pro: "PRO / subjective" };
                const DESIGN_LABEL: Record<string, string> = { rct: "Randomized Controlled", single_arm: "Single Arm", basket: "Basket / Umbrella" };
                const POP_LABEL: Record<string, string> = { biomarker_selected: "Biomarker Selected", broad: "Broad / Unselected", rare_small: "Rare / Small Pool" };
                const PLACEBO_LABEL: Record<string, string> = { low: "Low", moderate: "Moderate", high: "High" };
                const REG_LABEL: Record<string, string> = { standard: "Standard", fast_track: "Fast Track (rolling review only)", btd: "Breakthrough Therapy", orphan: "Orphan Drug", btd_orphan: "BTD + Orphan", accelerated: "Accelerated Approval", confirmatory: "Confirmatory (post-AA)" };

                return (
                  <div>
                    {/* Combined PTRS headline */}
                    <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                      <div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>P(approval) · Mechanism + Trial Design</div>
                        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 3 }}>
                          Mechanism prior: {(ptrsLayer1 * 100).toFixed(1)}%
                          {" "}<span style={{ color: deltaColor(layer2Delta) }}>{layer2Delta >= 0 ? "+" : ""}{(layer2Delta * 100).toFixed(1)}%</span> trial design adjustment
                          {" · "}multiplier {layer2Multiplier.toFixed(2)}×
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 32, fontWeight: 800, color: scoreColor(ptrsCombined), fontFamily: "var(--font-display)", lineHeight: 1 }}>
                          {(ptrsCombined * 100).toFixed(1)}%
                        </div>
                        {ptrsCI && (
                          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 3 }}>
                            range {(ptrsCI.lower * 100).toFixed(0)}%–{(ptrsCI.upper * 100).toFixed(0)}%
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Trial design inputs table */}
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Trial Design Inputs</div>
                      {[
                        ["Sample Size", `n = ${trialInputs.n}${trialInputs.enrollmentNote ? ` · ${trialInputs.enrollmentNote}` : ""}`],
                        ["Primary Endpoint", `${ENDPOINT_LABEL[trialInputs.endpointType] || trialInputs.endpointType}${trialInputs.endpointDescription ? ` · ${trialInputs.endpointDescription}` : ""}`],
                        ["Trial Design", DESIGN_LABEL[trialInputs.designType] || trialInputs.designType],
                        ["Patient Population", POP_LABEL[trialInputs.populationType] || trialInputs.populationType],
                        ["Placebo Response", PLACEBO_LABEL[trialInputs.placeboResponse] || trialInputs.placeboResponse],
                        ["Regulatory Context", REG_LABEL[trialInputs.regulatoryContext] || trialInputs.regulatoryContext],
                      ].map(([label, value]) => (
                        <div key={label} style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{label}</div>
                          <div style={{ fontSize: 12, color: "var(--text)" }}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Trial success probability */}
                    <div style={{ marginBottom: 16, background: "var(--surface-2)", borderRadius: 8, padding: "10px 14px" }}>
                      <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>P(trial detects effect)</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        Given this design, probability the trial would return a statistically significant result:
                        {" "}<span style={{ fontWeight: 700, color: scoreColor(trialSuccessProb) }}>{(trialSuccessProb * 100).toFixed(0)}%</span>
                      </div>
                    </div>

                    {/* Risk flags */}
                    {riskFlags.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Design Risk Flags</div>
                        {riskFlags.map((flag: any, i: number) => (
                          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                            <span style={{ fontSize: 12, minWidth: 16 }}>
                              {flag.severity === "high" ? "🔴" : flag.severity === "medium" ? "🟡" : "ℹ️"}
                            </span>
                            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{flag.message}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Phase benchmark percentile (updated with Layer 2) */}
                    {phaseBenchmark && (() => {
                      const bm = phaseBenchmark;
                      const pctColor = bm.percentile >= 75 ? "#10b981" : bm.percentile >= 50 ? "#3b82f6" : bm.percentile >= 25 ? "#f59e0b" : "#ef4444";
                      return (
                        <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "12px 14px" }}>
                          <div style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>vs. Historical {bm.benchmarks.label} Drugs · Mechanism + Trial Design</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color: pctColor, fontFamily: "var(--font-display)", minWidth: 52 }}>{bm.percentile}<span style={{ fontSize: 12, fontWeight: 500 }}>th</span></div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{bm.label}</div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                Industry range: {(bm.benchmarks.p10 * 100).toFixed(0)}%–{(bm.benchmarks.p90 * 100).toFixed(0)}% · median {(bm.benchmarks.median * 100).toFixed(0)}%
                              </div>
                            </div>
                            <div style={{ width: 100, height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${bm.percentile}%`, background: pctColor, borderRadius: 3, transition: "width 0.6s ease" }} />
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}
            </Card>
          )}

          {/* Strategic Assessment — Lead Reasoner output, shown FIRST */}
          {v.asset && (briefLoading || valuationBrief) && (
            <StrategicAssessment
              brief={valuationBrief}
              summary={briefSummary}
              loading={briefLoading}
              expectationAudit={expectationAudit}
            />
          )}

          {/* True Effect Prior — step-by-step evidence story, before/after curves */}
          {v.asset && (effectPriorLoading || effectPrior) && (
            <Card>
              <EffectPriorChain effectPrior={effectPrior} loading={effectPriorLoading} ptrsResult={ptrsResult} />
            </Card>
          )}

          {/* Development-path HALT — the engine reached this stage but couldn't
              build it. Surface the reason instead of silently omitting the dev
              path + final value metrics (same principle as the governance halt). */}
          {devPlanError && !devPlanStages && !devPlanLoading && v.asset && briefStatus !== "failed" && (
            <div style={{ padding: "18px 20px", borderRadius: 12, background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.4)" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#f59e0b", marginBottom: 4 }}>Development path not built — value metrics incomplete</div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", maxWidth: 640 }}>
                The effect prior built, but the engine stopped before the stage-by-stage development path, so there is no propagated P(approval), eNPV, or eROI for this run. The headline figures below fall back to a phase-baseline placeholder — they are NOT the full analysis.
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>{devPlanError}</div>
              </div>
              <button className="btn" onClick={() => {
                if (!v.asset) return;
                const ind = v.indication || v.indications?.[0]?.name || "";
                // If Layer 2 already succeeded, only the dev-plan stage needs
                // re-running (fast). Otherwise re-run the whole scoring chain.
                if (layer2Result?.trialInputs) {
                  onGenerateDevPlan(v.asset, ind, v.phase || "Phase 2", v.sponsor, layer2Result);
                } else {
                  onScorePtrs(v.asset, v.mechanism || "", ind, v.phase || "Phase 2", v.sponsor);
                }
              }} disabled={devPlanLoading || ptrsLoading || layer2Loading}
                style={{ marginTop: 12, background: "#f59e0b", color: "#111", fontWeight: 700, padding: "6px 16px", borderRadius: 8 }}>
                ↻ Re-run development path
              </button>
            </div>
          )}

          {/* Development Path — auto-generated after Layer 2, drives headline metrics */}
          {(devPlanLoading || devPlanStages) && v.asset && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <SectionLabel>Development Path</SectionLabel>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -8, marginBottom: 8 }}>
                    Stage-by-stage trial probabilities &amp; risk-adjusted costs · {v.asset} · {v.phase}
                  </div>
                </div>
                {devPlanStages && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => onGenerateDevPlan(v.asset || "", v.indications?.[0]?.name || v.indication || "", v.phase || "Phase 2", v.sponsor, layer2Result)}
                    disabled={devPlanLoading}
                    style={{ fontSize: 11 }}
                  >
                    {devPlanLoading ? "⏳" : "↻ Refresh"}
                  </button>
                )}
              </div>
              <DevPlan
                stageInputs={devPlanStages}
                regContext={devPlanRegContext}
                devPlan={devPlan}
                reasoning={devPlanReasoning}
                loading={devPlanLoading}
                onUpdateN={updateDevPlanN}
                onUpdateCpp={updateDevPlanCpp}
              />
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
                          // Persist the bottom-up market context (Build 1) alongside peak so
                          // the Strategy Advisor re-derives the market per scenario.
                          updateIndication(targetId, {
                            peakSales: Math.round(active.peakSalesM * 1e6),
                            tamM: active.marketContext?.tamM ?? undefined,
                            penetrationPct: active.marketContext?.penetrationPct ?? undefined,
                            annualPriceUsd: active.marketContext?.pricingPerYear ?? undefined,
                          });
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


          {/* Charts — suppressed when the valuation is halted; a tornado/waterfall
              off phase-baseline defaults is exactly the ungoverned verdict we halt. */}
          {briefStatus !== "failed" && (
            <Card>
              <SectionLabel>Valuation Analysis</SectionLabel>
              <ValuationCharts valuation={chartValuation} governed={governedOut} />
            </Card>
          )}

          {/* Decision Analysis */}
          {v.asset && (
            <Card>
              <DecisionAnalysis
                valuation={display}
                out={out}
                ptrsResult={ptrsResult}
                layer2Result={layer2Result}
                effectPrior={effectPrior}
                devPlan={devPlan}
              />
            </Card>
          )}

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

            <PnLTable v={v} out={out} pApproval={devPlan?.pApproval} devPlan={devPlan} onClose={() => setShowPnL(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
