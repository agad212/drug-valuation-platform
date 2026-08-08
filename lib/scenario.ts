// lib/scenario.ts
//
// Pure helpers for the scenario UI. A scenario BRANCH is the base input vector + deltas, run through the
// EXISTING computeOutputs (done in the component — the sanctioned recompute over an input vector, like
// the tornado sweep). These helpers only (a) transform the base valuation by a branch's input deltas and
// (b) do the weighted rollup Σ(wᵢ/Σw)·valueᵢ — trivial aggregation, NOT a valuation compute, no engine
// touch. Imports the Valuation TYPE only (no compute) — grep-provable no-leak.

import type { Valuation } from "./types";

// Input deltas off the base for one branch. USER-set this pass (bull/base/bear). Evidence-grounded /
// reasoned weighting is DEFERRED (wants calibration to ground the weights) — hand-set only here.
export type ScenarioDeltas = {
  peakMult?: number;          // multiply peak sales (top-level + each indication)
  ptrsOverride?: number | null; // absolute P(approval) override; null/undefined = keep base
  launchDelta?: number;       // shift launch year ± (top-level + each indication)
};

// Apply a branch's deltas to the base, producing a new input vector for computeOutputs. Pure.
export function applyScenarioDeltas(base: Valuation, d: ScenarioDeltas): Valuation {
  const v: Valuation = { ...base };
  const mult = d.peakMult;
  const shift = d.launchDelta ?? 0;
  const scalePeak = mult != null && mult !== 1;
  if (scalePeak && base.peakSales != null) v.peakSales = base.peakSales * mult!;
  if (shift !== 0 && base.launchYear != null) v.launchYear = base.launchYear + shift;
  if ((scalePeak || shift !== 0) && base.indications && base.indications.length) {
    v.indications = base.indications.map((ind) => {
      const next = { ...ind };
      if (scalePeak) next.peakSales = (ind.peakSales ?? base.peakSales ?? 0) * mult!;
      if (shift !== 0) {
        const ownLaunch = ind.launchYear ?? base.launchYear;
        if (ownLaunch != null) next.launchYear = ownLaunch + shift;
      }
      return next;
    });
  }
  if (d.ptrsOverride != null) v.ptrs = d.ptrsOverride;
  return v;
}

// ── Module 3: elicited Pearson-Tukey outer multipliers ──────────────────────────────────────────
// Derives the bear/bull peak multipliers from the LEAD indication's persisted elicited p05/p95
// (bearPeakM/bullPeakM, $M) against the lead peak. Pure and REACTIVE-safe: the component derives
// this per render (the old mount-time useState initializer meant the elicited values never took
// effect until a page reload — 8/8 code-review finding). Full precision: an early .toFixed(2)
// collapsed small ratios to a peak-zeroing 0 and near-1 ratios to a silent no-op.
// Returns the multipliers, or the REASON they don't apply (surfaced in the panel — a silent
// placeholder fallback violated §1.5). reason:null = nothing was elicited (the normal quiet case).
export function elicitedPeakMultipliers(base: Valuation):
  | { ok: true; bearMult: number; bullMult: number }
  | { ok: false; reason: string | null } {
  const lead = base.indications?.[0];
  const bear = lead?.bearPeakM;
  const bull = lead?.bullPeakM;
  if (bear == null || bull == null) return { ok: false, reason: null };
  const peakM = (lead?.peakSales ?? base.peakSales ?? 0) / 1e6;
  if (!(peakM > 0)) return { ok: false, reason: "elicited p05/p95 present but the lead peak is unset — placeholder multipliers govern" };
  // bear may legitimately be 0 (an honest "never really launches" p05) — ≥ 0, not > 0.
  if (!(bear >= 0 && bear < peakM && bull > peakM)) {
    return { ok: false, reason: `elicited p05/p95 ($${Math.round(bear)}M / $${Math.round(bull)}M) is incoherent against the lead peak $${Math.round(peakM)}M (likely a stale elicitation from before the peak changed) — placeholder multipliers govern until re-applied` };
  }
  // 4-dp display rounding, guarded: never round a real elicited value to a degenerate 0
  // (zeroes the whole peak) or exactly 1 (applyScenarioDeltas treats mult===1 as "no delta").
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const safeRound = (raw: number, allowZero: boolean) => {
    const r = round4(raw);
    if (r === 1 && raw !== 1) return raw;
    if (r === 0 && raw > 0 && !allowZero) return raw;
    return r;
  };
  return { ok: true, bearMult: safeRound(bear / peakM, bear === 0), bullMult: safeRound(bull / peakM, false) };
}

export type WeightedBranch = { weight: number; value: number };

// Probability-weighted rollup: Σ (wᵢ / Σw) · valueᵢ. Negative weights floored to 0; weights normalized
// (surfaced when Σw ≠ 1). Pure arithmetic — no valuation compute.
export function weightedRollup(branches: WeightedBranch[]): { expected: number; totalWeight: number; normalized: boolean } {
  const totalWeight = branches.reduce((s, b) => s + Math.max(0, b.weight), 0);
  if (totalWeight <= 0) return { expected: 0, totalWeight: 0, normalized: false };
  const expected = branches.reduce((s, b) => s + (Math.max(0, b.weight) / totalWeight) * b.value, 0);
  return { expected, totalWeight, normalized: Math.abs(totalWeight - 1) > 1e-9 };
}
