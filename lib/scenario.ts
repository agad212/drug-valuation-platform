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

export type WeightedBranch = { weight: number; value: number };

// Probability-weighted rollup: Σ (wᵢ / Σw) · valueᵢ. Negative weights floored to 0; weights normalized
// (surfaced when Σw ≠ 1). Pure arithmetic — no valuation compute.
export function weightedRollup(branches: WeightedBranch[]): { expected: number; totalWeight: number; normalized: boolean } {
  const totalWeight = branches.reduce((s, b) => s + Math.max(0, b.weight), 0);
  if (totalWeight <= 0) return { expected: 0, totalWeight: 0, normalized: false };
  const expected = branches.reduce((s, b) => s + (Math.max(0, b.weight) / totalWeight) * b.value, 0);
  return { expected, totalWeight, normalized: Math.abs(totalWeight - 1) > 1e-9 };
}
