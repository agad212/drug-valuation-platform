// lib/sequential-power.ts
//
// Group-sequential (interim-analysis) power — Layer 1, Phase 2. Deterministic numerics only, NO
// Monte Carlo, NO LLM. Efficacy boundaries only this pass (futility is a fast-follow).
//
// Method: the classical group-sequential boundary FAMILIES — O'Brien-Fleming (constant on the
// B-value/score scale: b_k ∝ t_k^{-1/2}) and Pocock (constant on the Z scale) — with the single
// family constant solved by the ARMITAGE-McPHERSON recursion so overall type-I = α. This reproduces
// the canonical tabulated boundaries exactly (OBF K=2 → 2.797/1.977; Pocock K=2 → 2.178). The
// recursion is a deterministic 1-D convolution of the independent normal increments of the score
// process on the B-value scale (B_k − B_{k−1} ~ N(ξ·Δt, Δt)); efficacy-only continuation is B_k < c_k.
//
// SINGLE-LOCUS: boundaries depend on α-spending + information times ONLY (never θ). P(cross) is the
// crossing probability of the SAME statistic driven by the drift ξ recovered from the base power in
// the caller — there is nowhere to inject effect. E[N] is a pure OUTPUT of the crossing probabilities.
//
// Imports normalCDF one-way from effect-prior (no cycle — effect-prior does not import this module).

import { normalCDF } from "./effect-prior";

export type SpendingFunction = "OBF" | "POCOCK";

const SQRT2PI = Math.sqrt(2 * Math.PI);
const normalPdf = (x: number): number => Math.exp(-0.5 * x * x) / SQRT2PI;

// Normalize look positions to information fractions ending at 1 (accepts fractions or raw info counts).
function normalizeLooks(t: number[]): number[] {
  const s = [...t].filter((x) => x > 0).sort((a, b) => a - b);
  const last = s[s.length - 1];
  return last > 0 ? s.map((x) => x / last) : s;
}

// ── Armitage-McPherson recursion. Z-scale efficacy boundaries bZ[k], information fractions t[k]
//    (increasing, t[K-1]=1), drift ξ (expected FINAL-look Z). Returns per-look FIRST-crossing probs
//    + expected information fraction. Convolution of independent normal increments on the B scale.
function crossing(bZ: number[], t: number[], drift: number, M = 513): { pCross: number; perLook: number[]; eInfoFrac: number } {
  const K = t.length;
  const c = bZ.map((b, k) => b * Math.sqrt(t[k])); // Z ≥ bZ_k ⟺ B ≥ bZ_k·√t_k
  const maxC = Math.max(...c);
  const span = drift * t[K - 1];
  const lo = Math.min(-8, span - 8);
  const hi = Math.max(maxC + 2, span + 8);
  const h = (hi - lo) / (M - 1);
  const x = new Array<number>(M);
  for (let i = 0; i < M; i++) x[i] = lo + i * h;

  const perLook = new Array<number>(K).fill(0);

  // look 1: B_1 ~ N(ξ·t_1, t_1)
  const sd1 = Math.sqrt(t[0]);
  let g = new Array<number>(M);
  for (let i = 0; i < M; i++) g[i] = normalPdf((x[i] - drift * t[0]) / sd1) / sd1;
  perLook[0] = trapMassAbove(g, x, h, c[0]);
  for (let i = 0; i < M; i++) if (x[i] >= c[0]) g[i] = 0; // continuation region only

  for (let k = 1; k < K; k++) {
    const dt = t[k] - t[k - 1];
    const sd = Math.sqrt(dt);
    const gn = new Array<number>(M).fill(0);
    for (let j = 0; j < M; j++) {
      let s = 0;
      for (let i = 0; i < M; i++) {
        const gi = g[i];
        if (gi === 0) continue;
        s += gi * (normalPdf((x[j] - x[i] - drift * dt) / sd) / sd);
      }
      gn[j] = s * h;
    }
    perLook[k] = trapMassAbove(gn, x, h, c[k]);
    for (let j = 0; j < M; j++) if (x[j] >= c[k]) gn[j] = 0;
    g = gn;
  }

  const pCross = perLook.reduce((a, b) => a + b, 0);
  let eInfoFrac = 0;
  for (let k = 0; k < K; k++) eInfoFrac += t[k] * perLook[k];
  eInfoFrac += t[K - 1] * (1 - pCross); // never crossed → reach the final look
  return { pCross, perLook, eInfoFrac };
}

// Trapezoidal integral of density g over the region x ≥ cutoff. The cutoff (the boundary c_k)
// generally falls BETWEEN grid points, so the partial cell [cutoff, x[i0]] is integrated with the
// density at the cutoff obtained by linear interpolation — dropping it systematically UNDER-counts
// the crossing probability (and inflates the solved boundary). This partial-cell handling is what
// makes the recursion reproduce the canonical boundary tables.
function trapMassAbove(g: number[], x: number[], h: number, cutoff: number): number {
  const last = g.length - 1;
  if (cutoff <= x[0]) {
    let s = 0.5 * (g[0] + g[last]);
    for (let i = 1; i < last; i++) s += g[i];
    return s * h;
  }
  if (cutoff >= x[last]) return 0;
  const i0 = Math.min(last, Math.max(1, Math.ceil((cutoff - x[0]) / h)));
  const gCut = g[i0 - 1] + ((g[i0] - g[i0 - 1]) * (cutoff - x[i0 - 1])) / h; // density at the exact cutoff
  let s = 0.5 * (gCut + g[i0]) * (x[i0] - cutoff); // partial cell [cutoff, x[i0]]
  for (let i = i0; i < last; i++) s += 0.5 * (g[i] + g[i + 1]) * h; // full trapezoids above
  return s;
}

const shapeFor = (spending: SpendingFunction) => (tk: number) => (spending === "OBF" ? 1 / Math.sqrt(tk) : 1);

// Solve the family constant C so P(cross ever | H0, drift 0) = totalAlpha (one-sided). Monotone
// decreasing in C → bisection. Boundaries are θ-independent → resolved ONCE per stage.
export function sequentialBoundaries(totalAlpha: number, lookFractions: number[], spending: SpendingFunction): {
  zBoundaries: number[];
  pCross: (drift: number) => number;
  expectedInfoFraction: (drift: number) => number;
} {
  const t = normalizeLooks(lookFractions);
  const shape = shapeFor(spending);
  let loC = 0.3, hiC = 10;
  for (let it = 0; it < 80; it++) {
    const midC = 0.5 * (loC + hiC);
    const a = crossing(t.map((tk) => midC * shape(tk)), t, 0).pCross;
    if (a > totalAlpha) loC = midC;
    else hiC = midC;
  }
  const C = 0.5 * (loC + hiC);
  const zBoundaries = t.map((tk) => C * shape(tk));
  return {
    zBoundaries,
    pCross: (drift: number) => crossing(zBoundaries, t, drift).pCross,
    expectedInfoFraction: (drift: number) => crossing(zBoundaries, t, drift).eInfoFrac,
  };
}

// Crossing probability / expected info fraction for ALREADY-resolved boundaries (used to build the
// per-θ drift→pCross table and the E[N] output in computeStageRR).
export function pCrossGivenBoundaries(zBoundaries: number[], lookFractions: number[], drift: number): number {
  return crossing(zBoundaries, normalizeLooks(lookFractions), drift).pCross;
}
export function expectedInfoFractionGivenBoundaries(zBoundaries: number[], lookFractions: number[], drift: number): number {
  return crossing(zBoundaries, normalizeLooks(lookFractions), drift).eInfoFrac;
}
