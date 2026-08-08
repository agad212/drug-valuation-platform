// components/ScenarioPanel.tsx
//
// Magical Build 3 — the scenario surface. A scenario is a set of INPUT VECTORS run through the EXISTING
// engine: each branch = base + deltas → computeOutputs (the sanctioned recompute over an input vector).
// The only new logic is the weighted rollup Σ(wᵢ/Σw)·eNPVᵢ (lib/scenario). This layer builds no spec and
// computes no valuation of its own — it sets input vectors, reads computeOutputs, and rolls up. The
// clinical dev-path (P structure) is shared from the base devPlan and shown once via the 7269dbe spine;
// branches vary the FINANCIAL inputs (peak, timeline) and the P override, driving the rNPV.
//
// USER-set weights this pass (default 25/50/25). Evidence-grounded / reasoned weighting is DEFERRED.

import React, { useState } from "react";
import type { Valuation } from "../lib/types";
import type { DevPlanResult } from "../lib/dev-plan";
import { computeOutputs } from "../lib/cashflow";
import { applyScenarioDeltas, weightedRollup, type ScenarioDeltas } from "../lib/scenario";
import DevPathSpine from "./DevPathSpine";

const fmtM = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${Math.round(n / 1e6)}M`);

type Branch = { id: string; label: string; weight: number; deltas: ScenarioDeltas };

const DEFAULT_BRANCHES: Branch[] = [
  // Extended Pearson-Tukey three-point discretization (Keefer & Bodily 1983): weights
  // 0.185 / 0.63 / 0.185 with the outer branches read as the p05/p95 values of the elicited
  // distribution. Replaces the hand-set 25/50/25 — a cited discretization, not a chosen one.
  // The ×0.7/×1.3 peak multipliers remain PLACEHOLDERS for p05/p95 until the revenue module's
  // elicited bear/bull land here (elicitation module 3); user-editable as before.
  { id: "bear", label: "Bear (p05)", weight: 0.185, deltas: { peakMult: 0.7 } },
  { id: "base", label: "Base (p50)", weight: 0.63, deltas: {} },
  { id: "bull", label: "Bull (p95)", weight: 0.185, deltas: { peakMult: 1.3 } },
];

// Module 3 wiring: when the lead indication carries the revenue module's ELICITED p05/p95
// (persisted on apply), the outer branches initialize from those TRUE elicited values instead of
// the ×0.7/×1.3 placeholders. Coherence-guarded (bear < base < bull) — incoherent → placeholders.
// Mount-time initialization; the fields stay user-editable as before.
function initialBranches(base: Valuation): Branch[] {
  const lead = base.indications?.[0];
  const peakM = (lead?.peakSales ?? base.peakSales ?? 0) / 1e6;
  const bear = lead?.bearPeakM;
  const bull = lead?.bullPeakM;
  if (peakM > 0 && bear != null && bull != null && bear > 0 && bear < peakM && bull > peakM) {
    return [
      { id: "bear", label: "Bear (p05, elicited)", weight: 0.185, deltas: { peakMult: +(bear / peakM).toFixed(2) } },
      { id: "base", label: "Base (p50)", weight: 0.63, deltas: {} },
      { id: "bull", label: "Bull (p95, elicited)", weight: 0.185, deltas: { peakMult: +(bull / peakM).toFixed(2) } },
    ];
  }
  return DEFAULT_BRANCHES;
}

export default function ScenarioPanel({ base, devPlan }: { base: Valuation; devPlan?: DevPlanResult | null }) {
  const [branches, setBranches] = useState<Branch[]>(() => initialBranches(base));

  const setWeight = (id: string, w: number) => setBranches((bs) => bs.map((b) => (b.id === id ? { ...b, weight: w } : b)));
  const setDelta = (id: string, k: keyof ScenarioDeltas, v: number | null) =>
    setBranches((bs) => bs.map((b) => (b.id === id ? { ...b, deltas: { ...b.deltas, [k]: v } } : b)));

  // Each branch drives the EXISTING computeOutputs over its input vector.
  const computed = branches.map((b) => ({ branch: b, out: computeOutputs(applyScenarioDeltas(base, b.deltas)) }));
  const roll = weightedRollup(computed.map((c) => ({ weight: c.branch.weight, value: c.out.rnpv })));

  const num = (v: number | null | undefined, ph: string, on: (n: number | null) => void) => (
    <input type="number" value={v ?? ""} placeholder={ph} onChange={(e) => on(e.target.value === "" ? null : Number(e.target.value))}
      className="input-base" style={{ width: "100%", fontSize: 11, padding: "3px 6px" }} />
  );

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 12, fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>
        Each branch = the base inputs + its deltas, run through the same engine. Set the probability weights; the expected
        eNPV is Σ&nbsp;(weight × branch&nbsp;eNPV). Clinical dev-path is shared (below); branches vary peak sales, launch, and the P override.
      </div>

      {/* shared dev-path spine (the clinical structure is invariant to financial scenarios unless P is overridden) */}
      {devPlan && <DevPathSpine devPlan={devPlan} />}

      {/* branch boxes */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch" }}>
        {computed.map(({ branch: b, out }) => {
          const pos = out.rnpv >= 0;
          return (
            <div key={b.id} style={{ flex: "1 1 180px", minWidth: 180, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", overflow: "hidden" }}>
              <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-display)" }}>{b.label}</span>
                <span style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-mono)", color: pos ? "var(--accent)" : "var(--danger)" }}>{fmtM(out.rnpv)}</span>
              </div>
              <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)" }}>Weight
                  {num(b.weight, "0.25", (n) => setWeight(b.id, n ?? 0))}
                </label>
                <label style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)" }}>Peak ×
                  {num(b.deltas.peakMult ?? null, "1.0", (n) => setDelta(b.id, "peakMult", n))}
                </label>
                <label style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)" }}>P override
                  {num(b.deltas.ptrsOverride ?? null, "auto", (n) => setDelta(b.id, "ptrsOverride", n))}
                </label>
                <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>P {(out.ptrs * 100).toFixed(0)}% · rev {fmtM(out.revenuePV)}</div>
              </div>
            </div>
          );
        })}

        {/* weighted rollup box */}
        <div style={{ flex: "1 1 180px", minWidth: 180, border: "1px solid var(--accent)", borderRadius: 10, background: "rgba(16,185,129,0.06)", overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--accent)" }}>
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-display)", color: "var(--accent)" }}>Probability-weighted eNPV</span>
          </div>
          <div style={{ padding: "12px" }}>
            <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "var(--font-mono)", color: roll.expected >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmtM(roll.expected)}</div>
            <div style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--font-mono)", marginTop: 6, lineHeight: 1.5 }}>
              Σ (weight × branch eNPV)
              {roll.normalized && <div style={{ color: "#f59e0b" }}>weights normalized from Σ={roll.totalWeight.toFixed(2)}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
