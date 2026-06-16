// ─── Decision Analysis Component ──────────────────────────────────────────────
//
// Option comparator: lets clinical teams define 2–4 strategic options and see
// the expected value tradeoffs side-by-side.
//
// Key metrics displayed:
//   eROI             = eNPV / Dev Cost
//   Marginal eROI    = ΔeNPV / |ΔDev Cost| vs Option A
//   eNPV             = PTRS × Revenue PV − Dev Cost PV
//   Risk range       = eNPV at PTRS CI bounds
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ScatterChart, Scatter, ZAxis,
} from "recharts";
import type { Valuation } from "../lib/types";
import {
  buildBaseContext,
  computeAllOptions,
  computeOption,
  generateBimodalVoiOption,
  type OptionInputs,
  type OptionResult,
  type BaseContext,
} from "../lib/decision-analysis";
import type { EndpointType, DesignType, PopulationType, PlaceboResponse, RegulatoryContext } from "../lib/ptrs-trial";
import type { EffectPrior } from "../lib/effect-prior";
import type { DevPlanResult } from "../lib/dev-plan";

// ─── Prop types ────────────────────────────────────────────────────────────────

type Props = {
  valuation: Valuation;
  out: { ptrs: number; revenuePV: number; devCostPV: number; rnpv: number };
  ptrsResult: any;   // from /api/ptrs-score
  layer2Result: any; // from /api/ptrs-layer2
  effectPrior?: EffectPrior | null; // from /api/effect-prior, if loaded
  devPlan?: DevPlanResult | null;   // from computeDevPlan, if available
};

// ─── Colour palette ────────────────────────────────────────────────────────────
// Option A is always accent green; options B/C/D get distinct colours.
// The 5th slot (purple/star) is reserved for the auto-generated
// Early-Signal Resolver option — never user-assignable.

const OPTION_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899", "#a855f7"];
const OPTION_LABELS = ["A", "B", "C", "D", "★"];

// ─── Format helpers (self-contained — not imported from index.tsx) ─────────────

function fmtM(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}B`;
  if (abs >= 1)    return `$${n.toFixed(0)}M`;
  return `~$0`;
}
function fmtPct(n?: number | null, dp = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(dp)}%`;
}
function fmtX(n: number | null): string {
  if (n == null) return "—";
  return `${n >= 0 ? "" : ""}${n.toFixed(2)}x`;
}
function uid(): string { return Math.random().toString(36).slice(2, 8); }

// ─── Empty option template ─────────────────────────────────────────────────────

function makeOption(overrides: Partial<OptionInputs> = {}): OptionInputs {
  return {
    id: uid(),
    name: "",
    categories: ["trial_design"],
    ...overrides,
  };
}

function makeBaselineOption(base: BaseContext): OptionInputs {
  return {
    id: "option-a",
    name: "Current Plan",
    isBaseline: true,
    // No overrides — all values come from base context
  };
}

// ─── Small reusable UI pieces ──────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)",
      textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4,
    }}>
      {children}
    </div>
  );
}

function SmallSelect({
  label, value, onChange, options,
}: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label style={{ display: "block" }}>
      <Label>{label}</Label>
      <select
        className="input-base"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ fontSize: 12, padding: "4px 8px", cursor: "pointer" }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function SmallNumber({
  label, value, onChange, placeholder, hint,
}: { label: string; value?: number; onChange: (v: number) => void; placeholder?: string; hint?: string }) {
  const [txt, setTxt] = useState(value != null ? String(value) : "");
  function commit(s: string) {
    const n = Number(s);
    if (!Number.isNaN(n) && n >= 0) onChange(n);
  }
  return (
    <label style={{ display: "block" }}>
      <Label>{label}{hint ? ` (${hint})` : ""}</Label>
      <input
        type="number" className="input-base"
        style={{ fontSize: 12, padding: "4px 8px" }}
        value={txt} placeholder={placeholder ?? ""}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => commit(txt)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(txt); }}
      />
    </label>
  );
}

// ─── Option Form ───────────────────────────────────────────────────────────────
// The form for configuring one option (excluding Option A which is auto-populated).

function OptionForm({
  option, base, color, onUpdate, onRemove,
}: {
  option: OptionInputs;
  base: BaseContext;
  color: string;
  onUpdate: (updates: Partial<OptionInputs>) => void;
  onRemove?: () => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const bt = base.baseTrialDesign;

  return (
    <div style={{
      border: `1px solid ${color}40`,
      borderRadius: 10,
      background: "var(--surface)",
      overflow: "hidden",
    }}>
      {/* Header row */}
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
          cursor: "pointer", background: `${color}10`,
          borderBottom: expanded ? `1px solid ${color}30` : "none",
        }}
      >
        <span style={{
          width: 22, height: 22, borderRadius: "50%",
          background: color, color: "#fff", fontSize: 11, fontWeight: 800,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, fontFamily: "var(--font-display)",
        }}>
          {option.isBaseline ? "A" : ""}
        </span>
        <input
          type="text"
          value={option.name}
          onChange={(e) => { e.stopPropagation(); onUpdate({ name: e.target.value }); }}
          onClick={(e) => e.stopPropagation()}
          placeholder="Option name (e.g. Expanded RCT)"
          style={{
            flex: 1, background: "none", border: "none", outline: "none",
            fontSize: 14, fontWeight: 600, color: "var(--text)",
            fontFamily: "var(--font-display)",
          }}
        />
        <span style={{ fontSize: 18, color: "var(--text-faint)", lineHeight: 1 }}>
          {expanded ? "▲" : "▼"}
        </span>
        {onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--text-faint)", lineHeight: 1, padding: 0 }}
          >×</button>
        )}
      </div>

      {/* Form body */}
      {expanded && (
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── Trial Design ── */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: color, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Trial Design
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
              <SmallNumber
                label="Sample size (n)"
                value={option.n ?? bt.n}
                onChange={(v) => onUpdate({ n: v })}
                placeholder={String(bt.n)}
              />
              <SmallSelect
                label="Trial design"
                value={option.designType ?? bt.designType}
                onChange={(v) => onUpdate({ designType: v as DesignType })}
                options={[
                  { value: "single_arm", label: "Single arm" },
                  { value: "rct",        label: "RCT (2-arm)" },
                  { value: "basket",     label: "Basket/umbrella" },
                ]}
              />
              <SmallSelect
                label="Arm count"
                value={String(option.numArms ?? (bt.designType === "single_arm" ? 1 : 2))}
                onChange={(v) => onUpdate({ numArms: v === "adaptive" ? "adaptive" : Number(v) as 1 | 2 | 3 })}
                options={[
                  { value: "1",        label: "1 (single arm)" },
                  { value: "2",        label: "2 (drug vs control)" },
                  { value: "3",        label: "3 (drug vs SOC vs placebo)" },
                  { value: "adaptive", label: "Adaptive" },
                ]}
              />
              <SmallSelect
                label="Primary endpoint"
                value={option.endpointType ?? bt.endpointType}
                onChange={(v) => onUpdate({ endpointType: v as EndpointType })}
                options={[
                  { value: "hard",      label: "Hard (OS, CR)" },
                  { value: "surrogate", label: "Surrogate (PFS, ORR)" },
                  { value: "pro",       label: "PRO/subjective" },
                ]}
              />
              <SmallSelect
                label="Regulatory context"
                value={option.regulatoryContext ?? bt.regulatoryContext}
                onChange={(v) => onUpdate({ regulatoryContext: v as RegulatoryContext })}
                options={[
                  { value: "standard",      label: "Standard" },
                  { value: "btd",           label: "BTD" },
                  { value: "orphan",        label: "Orphan" },
                  { value: "btd_orphan",    label: "BTD + Orphan" },
                  { value: "accelerated",   label: "Accelerated" },
                  { value: "confirmatory",  label: "Confirmatory" },
                ]}
              />
            </div>
          </div>

          {/* ── Patient Selection ── */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: color, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Patient Selection
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
              <SmallSelect
                label="Population type"
                value={option.populationType ?? bt.populationType}
                onChange={(v) => onUpdate({ populationType: v as PopulationType })}
                options={[
                  { value: "broad",               label: "Broad/unselected" },
                  { value: "biomarker_selected",   label: "Biomarker-selected" },
                  { value: "rare_small",           label: "Rare/orphan" },
                ]}
              />
              <SmallSelect
                label="Inclusion criteria"
                value={option.inclusionCriteria ?? "standard"}
                onChange={(v) => onUpdate({ inclusionCriteria: v as "tight" | "standard" | "broad" })}
                options={[
                  { value: "tight",    label: "Tight (enriched)" },
                  { value: "standard", label: "Standard" },
                  { value: "broad",    label: "Broad (wide)" },
                ]}
              />
              <SmallSelect
                label="Placebo response"
                value={option.placeboResponse ?? bt.placeboResponse}
                onChange={(v) => onUpdate({ placeboResponse: v as PlaceboResponse })}
                options={[
                  { value: "low",      label: "Low" },
                  { value: "moderate", label: "Moderate" },
                  { value: "high",     label: "High" },
                ]}
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              {option.inclusionCriteria === "tight"
                ? "Tight criteria: raises P(approval) (enriched for responders) but narrows label → peak sales ×0.7"
                : option.inclusionCriteria === "broad"
                ? "Broad criteria: wider addressable market → peak sales ×1.2 but more trial noise"
                : ""}
            </div>
          </div>

          {/* ── Partnership ── */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: color, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Ownership / Partnership
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
              <SmallNumber
                label="Ownership %"
                value={option.ownershipPct ?? 100}
                onChange={(v) => onUpdate({ ownershipPct: Math.min(100, v) })}
                hint="of costs + revenue"
                placeholder="100"
              />
              <SmallSelect
                label="Structure"
                value={option.isOutlicensed ? "licensed" : "owned"}
                onChange={(v) => onUpdate({ isOutlicensed: v === "licensed" })}
                options={[
                  { value: "owned",    label: "Fully owned / co-dev" },
                  { value: "licensed", label: "Out-licensed (royalty)" },
                ]}
              />
              {option.isOutlicensed && (
                <SmallNumber
                  label="Royalty %"
                  value={option.royaltyPctOverride != null ? option.royaltyPctOverride * 100 : (base.avgRoyalty * 100)}
                  onChange={(v) => onUpdate({ royaltyPctOverride: v / 100 })}
                  hint="%"
                />
              )}
            </div>
          </div>

          {/* ── VOI toggle ── */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: option.isVOI ? 10 : 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: color, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Value of Information (VOI)
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!option.isVOI}
                  onChange={(e) => onUpdate({ isVOI: e.target.checked })}
                />
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Run study first, then decide</span>
              </label>
            </div>
            {option.isVOI && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
                <SmallSelect
                  label="Study type"
                  value={option.voiType ?? "pilot"}
                  onChange={(v) => onUpdate({ voiType: v as any })}
                  options={[
                    { value: "pilot",               label: "Pilot / signal-finding" },
                    { value: "biomarker_validation", label: "Biomarker validation" },
                    { value: "adaptive_interim",     label: "Adaptive + interim" },
                    { value: "dose_optimization",    label: "Dose optimization" },
                  ]}
                />
                <SmallNumber
                  label="Study cost ($M)"
                  value={option.voiCostM}
                  onChange={(v) => onUpdate({ voiCostM: v })}
                  placeholder="15"
                />
                <SmallNumber
                  label="Time added (months)"
                  value={option.voiMonths}
                  onChange={(v) => onUpdate({ voiMonths: v })}
                  placeholder="12"
                />
                <SmallNumber
                  label="P(study positive) %"
                  value={option.voiProbPositive != null ? option.voiProbPositive * 100 : undefined}
                  onChange={(v) => onUpdate({ voiProbPositive: Math.min(1, v / 100) })}
                  placeholder="60"
                  hint="%"
                />
                <SmallNumber
                  label="P(approval) boost if positive %"
                  value={option.voiPtrsBoostIfPositive != null ? option.voiPtrsBoostIfPositive * 100 : undefined}
                  onChange={(v) => onUpdate({ voiPtrsBoostIfPositive: v / 100 })}
                  placeholder="8"
                  hint="absolute"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Result Card ───────────────────────────────────────────────────────────────
// Side-by-side card showing computed results for one option.

function ResultCard({
  result, index, isBaseline, isAutoGenerated,
}: {
  result: OptionResult;
  index: number;
  isBaseline: boolean;
  isAutoGenerated?: boolean;
}) {
  const color = OPTION_COLORS[index] ?? "#6b7280";
  const label = OPTION_LABELS[index] ?? String(index + 1);
  const { eROI, marginalEROI, eNPVM, eNPVLowM, eNPVHighM, ptrs, ptrsCI, peakSalesM, devCostM, deltaENPVM, deltaCostM, keyDrivers, voiENPVM } = result;

  const eROIColor = eROI == null ? "var(--text-muted)" : eROI >= 2 ? "#10b981" : eROI >= 1 ? "#3b82f6" : "#ef4444";
  const margColor = marginalEROI == null ? "var(--text-muted)" : marginalEROI >= 1 ? "#10b981" : marginalEROI >= 0 ? "#3b82f6" : "#ef4444";
  const eNPVColor = eNPVM >= 0 ? "var(--accent)" : "var(--danger, #ef4444)";

  return (
    <div style={{
      border: `1.5px solid ${color}50`,
      borderRadius: 12,
      background: "var(--surface)",
      flex: "1 1 220px",
      minWidth: 0,
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Option label header */}
      <div style={{
        background: `${color}18`,
        borderBottom: `1px solid ${color}30`,
        padding: "10px 14px",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{
          width: 24, height: 24, borderRadius: "50%",
          background: color, color: "#fff",
          fontSize: 11, fontWeight: 800, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--font-display)",
        }}>
          {label}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {result.option.name || `Option ${label}`}
        </span>
        {isBaseline && (
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20, background: `${color}25`, color }}>
            BASELINE
          </span>
        )}
        {isAutoGenerated && (
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20, background: `${color}25`, color }}>
            SUGGESTED
          </span>
        )}
      </div>

      {/* Why this option exists (auto-generated Early-Signal Resolver only) */}
      {isAutoGenerated && (
        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-faint)", borderBottom: "1px solid var(--border)", lineHeight: 1.5 }}>
          Your evidence review found two very different possible outcomes for this drug — one where it works as hoped, one where it doesn't.
          This smaller, faster study is sized to reveal which one is true before you commit to the full next-stage trial.
        </div>
      )}

      {/* Design summary */}
      {(result.option.n || result.option.designType || result.option.regulatoryContext) && (
        <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--text-faint)", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)" }}>
          {[
            result.option.designType?.replace("_", " ") ?? "",
            result.option.n ? `n=${result.option.n}` : "",
            result.option.regulatoryContext !== "standard" ? result.option.regulatoryContext?.replace("_", "+") : "",
            result.option.inclusionCriteria !== "standard" && result.option.inclusionCriteria ? result.option.inclusionCriteria : "",
          ].filter(Boolean).join(" · ")}
        </div>
      )}

      {/* Primary metrics */}
      <div style={{ padding: "14px 14px 6px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          {/* eROI */}
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>eROI</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: eROIColor, fontFamily: "var(--font-display)", lineHeight: 1 }}>
              {eROI != null ? fmtX(eROI) : "—"}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2 }}>eNPV / Dev Cost</div>
          </div>
          {/* Marginal eROI */}
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>
              {isBaseline ? "Marginal eROI" : "Marginal vs A"}
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, fontFamily: "var(--font-display)", lineHeight: 1, color: isBaseline ? "var(--text-faint)" : margColor }}>
              {isBaseline ? "—" : marginalEROI != null ? fmtX(marginalEROI) : (deltaCostM === 0 ? "∞" : "—")}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2 }}>
              {isBaseline ? "baseline" : deltaCostM != null && deltaCostM < 0 ? "per $ saved" : "per $ spent"}
            </div>
          </div>
        </div>

        {/* eNPV */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>eNPV</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: eNPVColor, fontFamily: "var(--font-mono)" }}>
            {fmtM(eNPVM)}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2 }}>
            range {fmtM(eNPVLowM)} – {fmtM(eNPVHighM)}
          </div>
        </div>

        {/* Secondary metrics */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>P(approval)</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              {fmtPct(ptrs)}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-faint)" }}>
              {fmtPct(ptrsCI.lower, 0)}–{fmtPct(ptrsCI.upper, 0)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Peak Sales</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              {fmtM(peakSalesM)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Dev Cost</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              {fmtM(devCostM)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Revenue PV</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              {fmtM(result.revenuePVM)}
            </div>
          </div>
        </div>

        {/* vs Option A delta row */}
        {!isBaseline && (deltaENPVM != null || deltaCostM != null) && (
          <div style={{
            background: "var(--surface-2)", borderRadius: 8, padding: "8px 10px",
            fontSize: 12, fontFamily: "var(--font-mono)", marginBottom: 10,
          }}>
            <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>vs Option A</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {deltaENPVM != null && (
                <span style={{ color: deltaENPVM >= 0 ? "#10b981" : "#ef4444", fontWeight: 600 }}>
                  {deltaENPVM >= 0 ? "+" : ""}{fmtM(deltaENPVM)} eNPV
                </span>
              )}
              {deltaCostM != null && (
                <span style={{ color: deltaCostM > 0 ? "#ef4444" : "#10b981", fontWeight: 600 }}>
                  {deltaCostM >= 0 ? "+" : ""}{fmtM(deltaCostM)} cost
                </span>
              )}
            </div>
            {marginalEROI != null && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
                Marginal dollar: {fmtX(marginalEROI)} return {deltaCostM != null && deltaCostM < 0 ? "(per $ saved)" : "(per $ spent)"}
              </div>
            )}
          </div>
        )}

        {/* VOI result */}
        {voiENPVM != null && (
          <div style={{
            background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)",
            borderRadius: 8, padding: "8px 10px", marginBottom: 10, fontSize: 12,
          }}>
            <div style={{ color: "var(--text-muted)", marginBottom: 4, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>VOI Path</div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: voiENPVM >= 0 ? "#10b981" : "#ef4444" }}>
              {fmtM(voiENPVM)} expected value
            </div>
            {result.voiVsDirectM != null && (
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                {result.voiVsDirectM >= 0 ? "+" : ""}{fmtM(result.voiVsDirectM)} vs going direct (Option A)
              </div>
            )}
          </div>
        )}

        {/* Key drivers */}
        {keyDrivers.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.07em" }}>Key Drivers</div>
            {keyDrivers.map((d, i) => (
              <div key={i} style={{ fontSize: 11, color: "var(--text-faint)", padding: "2px 0", display: "flex", gap: 6 }}>
                <span style={{ color: color }}>▸</span> {d}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Charts ───────────────────────────────────────────────────────────────────

function ComparisonCharts({ results }: { results: OptionResult[] }) {
  const labels = results.map((r, i) => r.option.name || `Option ${OPTION_LABELS[i]}`);

  const eROIData = results.map((r, i) => ({
    name: OPTION_LABELS[i] ?? String(i + 1),
    label: labels[i],
    eROI: r.eROI ?? 0,
    color: OPTION_COLORS[i] ?? "#6b7280",
  }));

  const eNPVData = results.map((r, i) => ({
    name: OPTION_LABELS[i] ?? String(i + 1),
    label: labels[i],
    eNPV: r.eNPVM,
    color: OPTION_COLORS[i] ?? "#6b7280",
  }));

  // Scatter: eNPV (y) vs Dev Cost (x) — efficiency frontier
  const scatterData = results.map((r, i) => ({
    devCost: r.devCostM,
    eNPV: r.eNPVM,
    name: OPTION_LABELS[i] ?? String(i + 1),
    label: labels[i],
    color: OPTION_COLORS[i] ?? "#6b7280",
  }));

  const tooltipStyle = {
    background: "var(--bg-card-solid)",
    border: "1px solid var(--border)",
    borderRadius: 8, fontSize: 12, color: "var(--text)",
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
      {/* eROI bar chart */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          eROI by Option
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={eROIData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={(v) => `${v.toFixed(1)}x`} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number, _: any, p: any) => [`${v.toFixed(2)}x`, p.payload.label]}
            />
            <Bar dataKey="eROI" radius={[4, 4, 0, 0]}>
              {eROIData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* eNPV bar chart */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          eNPV by Option ($M)
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={eNPVData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={(v) => `$${v.toFixed(0)}M`} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number, _: any, p: any) => [`$${v.toFixed(0)}M`, p.payload.label]}
            />
            <Bar dataKey="eNPV" radius={[4, 4, 0, 0]}>
              {eNPVData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Scatter: eNPV vs Dev Cost (efficiency frontier) */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          eNPV vs Dev Cost — Efficiency Frontier
        </div>
        <div style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 8 }}>
          Up-right = best. Options dominated (lower eNPV, higher cost) are unfavorable.
        </div>
        <ResponsiveContainer width="100%" height={140}>
          <ScatterChart margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" dataKey="devCost" name="Dev Cost" tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={(v) => `$${v.toFixed(0)}M`} label={{ value: "Dev Cost ($M)", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--text-faint)" }} />
            <YAxis type="number" dataKey="eNPV" name="eNPV" tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickFormatter={(v) => `$${v.toFixed(0)}M`} />
            <ZAxis range={[60, 60]} />
            <Tooltip
              contentStyle={tooltipStyle}
              content={({ payload }) => {
                if (!payload?.length) return null;
                const d = payload[0]?.payload;
                return (
                  <div style={{ ...tooltipStyle, padding: "8px 12px" }}>
                    <div style={{ fontWeight: 700 }}>{d.label}</div>
                    <div>eNPV: {fmtM(d.eNPV)}</div>
                    <div>Dev Cost: {fmtM(d.devCost)}</div>
                  </div>
                );
              }}
            />
            <Scatter data={scatterData} fill="#10b981">
              {scatterData.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Sensitivity Table ────────────────────────────────────────────────────────
// Shows how the ranking changes if PTRS assumptions shift ±10%.

function SensitivityTable({ results, base }: { results: OptionResult[]; base: BaseContext }) {
  const scenarios = [
    { label: "Bear (P(approval) −10%)", ptrsShift: -0.10 },
    { label: "Base",                    ptrsShift:  0    },
    { label: "Bull (P(approval) +10%)", ptrsShift: +0.10 },
  ];

  const tableResults = scenarios.map(({ label, ptrsShift }) =>
    results.map((r) => {
      const adjPtrs = Math.max(0.01, Math.min(0.99, r.ptrs + ptrsShift));
      const adjENPV = round1(adjPtrs * r.revenuePVM - r.devCostM);
      const adjROI  = r.devCostM > 0 ? round2(adjENPV / r.devCostM) : null;
      return { adjPtrs, adjENPV, adjROI };
    })
  );

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
        Sensitivity — Does the ranking change if P(approval) shifts ±10%?
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--font-mono)" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: "6px 10px", textAlign: "left", fontSize: 10, color: "var(--text-faint)", fontWeight: 600, textTransform: "uppercase" }}>Scenario</th>
              {results.map((r, i) => (
                <th key={i} style={{ padding: "6px 10px", textAlign: "right", fontSize: 10, color: OPTION_COLORS[i], fontWeight: 700, textTransform: "uppercase" }}>
                  {OPTION_LABELS[i]} — {r.option.name || `Option ${OPTION_LABELS[i]}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scenarios.map((sc, si) => (
              <tr key={si} style={{ borderBottom: "1px solid var(--border)", background: si === 1 ? "var(--surface-2)" : undefined }}>
                <td style={{ padding: "7px 10px", fontWeight: si === 1 ? 700 : 400, color: si === 1 ? "var(--text)" : "var(--text-muted)" }}>
                  {sc.label}
                </td>
                {tableResults[si].map((cell, ci) => (
                  <td key={ci} style={{ padding: "7px 10px", textAlign: "right" }}>
                    <span style={{ fontWeight: 600, color: cell.adjENPV >= 0 ? OPTION_COLORS[ci] : "#ef4444" }}>
                      {fmtM(cell.adjENPV)}
                    </span>
                    <span style={{ color: "var(--text-faint)", marginLeft: 8 }}>
                      {cell.adjROI != null ? `(${cell.adjROI.toFixed(1)}x)` : ""}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function round1(x: number) { return Math.round(x * 10) / 10; }
function round2(x: number) { return Math.round(x * 100) / 100; }

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DecisionAnalysis({ valuation, out, ptrsResult, layer2Result, effectPrior, devPlan }: Props) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<OptionInputs[]>([]);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  // Build base context from current valuation + PTRS results
  const base = useMemo(
    () => buildBaseContext(valuation, out, ptrsResult, layer2Result, effectPrior, devPlan),
    [valuation, out, ptrsResult, layer2Result, effectPrior, devPlan]
  );

  // Initialize options when the panel opens for the first time
  const handleOpen = useCallback(() => {
    if (!open && options.length === 0 && base) {
      setOptions([
        makeBaselineOption(base),
        makeOption({ name: "Option B" }),
      ]);
    }
    setOpen(true);
  }, [open, options.length, base]);

  // Compute results from current option definitions, plus the auto-generated
  // Early-Signal Resolver option (if the effect prior is bimodal). The resolver
  // is appended after the user-configured options and does not count against
  // the 4-option cap below.
  const results = useMemo(() => {
    if (!base) return [];
    const computed = computeAllOptions(base, options);
    const resolverOption = generateBimodalVoiOption(base);
    if (resolverOption) {
      const optionA = computed.find((r) => r.option.isBaseline) ?? computed[0];
      computed.push(computeOption(base, resolverOption, optionA));
    }
    return computed;
  }, [base, options]);

  function addOption() {
    if (options.length >= 4) return;
    setOptions((prev) => [...prev, makeOption({ name: `Option ${OPTION_LABELS[prev.length] ?? String(prev.length + 1)}` })]);
    setAiSummary(null);
  }

  function updateOption(id: string, updates: Partial<OptionInputs>) {
    setOptions((prev) => prev.map((o) => o.id === id ? { ...o, ...updates } : o));
    setAiSummary(null);
  }

  function removeOption(id: string) {
    setOptions((prev) => prev.filter((o) => o.id !== id));
    setAiSummary(null);
  }

  async function getAiInsight() {
    if (!results.length) return;
    setAiLoading(true);
    try {
      const res = await fetch("/api/decision-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drug: valuation.asset || valuation.name,
          phase: valuation.phase,
          options: results.map((r) => ({
            name: r.option.name || "unnamed",
            eNPVM: r.eNPVM,
            eROI: r.eROI,
            marginalEROI: r.marginalEROI,
            ptrs: r.ptrs,
            peakSalesM: r.peakSalesM,
            devCostM: r.devCostM,
            keyDrivers: r.keyDrivers,
            isVOI: r.option.isVOI,
            voiENPVM: r.voiENPVM,
          })),
        }),
      });
      if (!res.ok) throw new Error("AI insight failed");
      const data = await res.json();
      setAiSummary(data.insight);
    } catch (e) {
      console.error("[decision-analysis] AI insight failed:", e);
      setAiSummary("AI insight unavailable — check console for errors.");
    } finally {
      setAiLoading(false);
    }
  }

  // Don't render if no drug has been entered
  if (!valuation.asset && !(valuation as any).name) return null;

  return (
    <div>
      {/* Entry point button — shown when panel is closed */}
      {!open && (
        <button
          className="btn btn-outline"
          onClick={handleOpen}
          style={{ width: "100%", justifyContent: "center", fontSize: 14, padding: "12px 0", fontWeight: 700 }}
        >
          Strategic Decision Analysis ↗
        </button>
      )}

      {/* Full panel */}
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Panel header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)", fontFamily: "var(--font-display)" }}>
                Strategic Decision Analysis
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {valuation.asset} · Compare up to 4 strategic options side-by-side.
                Option A is your current plan.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {options.length < 4 && (
                <button className="btn btn-outline" onClick={addOption} style={{ fontSize: 12 }}>
                  + Add Option
                </button>
              )}
              <button className="btn btn-ghost" onClick={() => setOpen(false)} style={{ fontSize: 12 }}>
                Close ×
              </button>
            </div>
          </div>

          {/* No data warning */}
          {!base && (
            <div style={{
              background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)",
              borderRadius: 10, padding: "16px 20px", fontSize: 13, color: "#92400e",
            }}>
              Run <strong>Auto-Valuate</strong> first to populate peak sales, dev cost, and Approval Probability data. Decision Analysis builds on top of the existing valuation.
            </div>
          )}

          {/* Option builder forms */}
          {base && (
            <>
              {/* Option A: read-only summary */}
              <div style={{
                border: "1.5px solid #10b98150",
                borderRadius: 10,
                background: "var(--surface)",
                overflow: "hidden",
              }}>
                <div style={{
                  background: "#10b98110", borderBottom: "1px solid #10b98130",
                  padding: "10px 14px", display: "flex", alignItems: "center", gap: 10,
                }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: "50%", background: "#10b981", color: "#fff",
                    fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: "var(--font-display)",
                  }}>A</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-display)" }}>
                    Option A — Current Plan (auto-populated)
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20, background: "#10b98125", color: "#10b981" }}>BASELINE</span>
                </div>
                <div style={{ padding: "10px 14px", display: "flex", gap: 20, flexWrap: "wrap", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  <span>n = {base.baseTrialDesign.n} · {base.baseTrialDesign.designType.replace("_", " ")} · {base.baseTrialDesign.regulatoryContext}</span>
                  <span>P(approval): {fmtPct(base.ptrs)}</span>
                  <span>Peak Sales: {fmtM(base.peakSalesM)}</span>
                  <span>Dev Cost: {fmtM(base.devCostM)}</span>
                  <span>Phase: {base.phase}</span>
                </div>
              </div>

              {/* Editable options (B, C, D) */}
              {options.filter((o) => !o.isBaseline).map((option, i) => (
                <OptionForm
                  key={option.id}
                  option={option}
                  base={base}
                  color={OPTION_COLORS[i + 1] ?? "#6b7280"}
                  onUpdate={(updates) => updateOption(option.id, updates)}
                  onRemove={options.filter((o) => !o.isBaseline).length > 1 ? () => removeOption(option.id) : undefined}
                />
              ))}
            </>
          )}

          {/* Results section */}
          {results.length > 0 && (
            <>
              {/* Side-by-side comparison cards */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 12, fontFamily: "var(--font-display)" }}>
                  Comparison
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {results.map((r, i) => (
                    <ResultCard
                      key={r.option.id}
                      result={r}
                      index={i}
                      isBaseline={!!r.option.isBaseline || i === 0}
                      isAutoGenerated={r.option.id === "voi-resolver"}
                    />
                  ))}
                </div>
              </div>

              {/* Charts */}
              <div style={{
                background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 12, padding: 20,
              }}>
                <ComparisonCharts results={results} />
              </div>

              {/* Sensitivity table */}
              <div style={{
                background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 12, padding: 20,
              }}>
                <SensitivityTable results={results} base={base!} />
              </div>

              {/* AI insight */}
              <div style={{
                background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 12, padding: 20,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    AI Strategic Insight
                  </div>
                  <button
                    className="btn btn-outline"
                    onClick={getAiInsight}
                    disabled={aiLoading}
                    style={{ fontSize: 12 }}
                  >
                    {aiLoading ? "⏳ Generating…" : aiSummary ? "↻ Refresh" : "Generate Insight"}
                  </button>
                </div>
                {aiSummary ? (
                  <div style={{
                    background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)",
                    borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "var(--text)", lineHeight: 1.7,
                  }}>
                    {aiSummary}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                    Click "Generate Insight" for a 2–3 sentence AI summary of what the comparison means for your decision.
                  </div>
                )}
              </div>

              {/* Methodology note */}
              <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.6, fontFamily: "var(--font-mono)" }}>
                eNPV = P(approval) × Revenue PV − Dev Cost PV · eROI = eNPV / Dev Cost · Marginal eROI = ΔeNPV / |ΔDev Cost| vs Option A ·
                P(approval) recalculated per option using trial design simulation · Dev cost scales at n^0.75 (sub-linear) ·
                Tight inclusion: peak sales ×0.70 · Broad inclusion: ×1.20 · RCT label premium: ×1.10 · Single arm discount: ×0.90
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
