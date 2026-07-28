// lib/sequential-power.ts
//
// Group-sequential (interim-analysis) power — Layer 1, Phase 2 (efficacy) + futility (fast-follow).
// Deterministic numerics only, NO Monte Carlo, NO LLM.
//
// Method: the classical group-sequential boundary FAMILIES — O'Brien-Fleming (constant on the
// B-value/score scale: b_k ∝ t_k^{-1/2}) and Pocock (constant on the Z scale) — with the family
// constant solved by the ARMITAGE-McPHERSON recursion so overall type-I = α. Reproduces the canonical
// tabulated boundaries exactly (OBF K=2 → 2.797/1.977; Pocock K=2 → 2.178). The recursion is a
// deterministic 1-D convolution of the independent normal increments of the score process on the
// B-value scale (B_k − B_{k−1} ~ N(ξ·Δt, Δt)); efficacy continuation is B_k < c_k.
//
// FUTILITY (this pass): a LOWER absorbing barrier a_k is ADDED to the SAME recursion (continuation
// becomes a_k < B_k < c_k). β-spending sets a_k under the design alternative ξ_design. NON-BINDING
// leaves the efficacy boundaries untouched (type-I = α unchanged; futility only truncates power).
// BINDING re-solves the efficacy boundaries LOWER via a fixed point so total type-I stays exactly α
// (a trajectory crossing futility EXITS, so it can no longer reach efficacy — the recovered α is spent
// on a lower efficacy bar, never double-counted). When a_k is absent the recursion is byte-identical
// to the efficacy-only Phase-2 path.
//
// SINGLE-LOCUS: boundaries depend on α/β-spending + information times + ξ_design ONLY. ξ_design is a
// READOUT of the prior mean supplied by the caller — the effect lives in the prior. P(cross) and E[N]
// are OUTPUTS. A futility parameter places the lower barrier; it cannot move the effect.
//
// Imports normalCDF one-way from effect-prior (no cycle); normalInv is local (self-contained).

import { normalCDF } from "./effect-prior";

export type SpendingFunction = "OBF" | "POCOCK";
export type FutilityConfig = { binding: boolean; beta: number; spending: SpendingFunction };

const SQRT2PI = Math.sqrt(2 * Math.PI);
const normalPdf = (x: number): number => Math.exp(-0.5 * x * x) / SQRT2PI;

// Inverse standard-normal CDF (Acklam; |abs error| < 1.15e-9). Local to keep this module cycle-free.
function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// Normalize look positions to information fractions ending at 1 (accepts fractions or raw info counts).
function normalizeLooks(t: number[]): number[] {
  const s = [...t].filter((x) => x > 0).sort((a, b) => a - b);
  const last = s[s.length - 1];
  return last > 0 ? s.map((x) => x / last) : s;
}

// ── Armitage-McPherson recursion. Z-scale efficacy boundaries bZ[k], information fractions t[k]
//    (increasing, t[K-1]=1), drift ξ. OPTIONAL Z-scale futility lower boundaries aZ[k] — when absent
//    the recursion is byte-identical to the efficacy-only path. Returns per-look first-crossing probs
//    (efficacy + futility) and the expected information fraction. Convolution on the B scale.
function crossing(bZ: number[], t: number[], drift: number, M = 513, aZ?: number[]): {
  pCross: number; perLook: number[]; eInfoFrac: number; pFutility: number; perLookFut: number[];
} {
  const K = t.length;
  const c = bZ.map((b, k) => b * Math.sqrt(t[k])); // efficacy upper: Z ≥ bZ_k ⟺ B ≥ bZ_k·√t_k
  const cLo = aZ ? aZ.map((a, k) => a * Math.sqrt(t[k])) : null; // futility lower (null → efficacy-only)
  const maxC = Math.max(...c);
  const span = drift * t[K - 1];
  const lo = Math.min(-8, span - 8);
  const hi = Math.max(maxC + 2, span + 8);
  const h = (hi - lo) / (M - 1);
  const x = new Array<number>(M);
  for (let i = 0; i < M; i++) x[i] = lo + i * h;

  const perLook = new Array<number>(K).fill(0);
  const perLookFut = new Array<number>(K).fill(0);

  // look 1: B_1 ~ N(ξ·t_1, t_1)
  const sd1 = Math.sqrt(t[0]);
  let g = new Array<number>(M);
  for (let i = 0; i < M; i++) g[i] = normalPdf((x[i] - drift * t[0]) / sd1) / sd1;
  perLook[0] = trapMassAbove(g, x, h, c[0]);
  if (cLo) perLookFut[0] = trapMassBelow(g, x, h, cLo[0]);
  for (let i = 0; i < M; i++) if (x[i] >= c[0] || (cLo && x[i] <= cLo[0])) g[i] = 0; // continuation region only

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
    if (cLo) perLookFut[k] = trapMassBelow(gn, x, h, cLo[k]);
    for (let j = 0; j < M; j++) if (x[j] >= c[k] || (cLo && x[j] <= cLo[k])) gn[j] = 0;
    g = gn;
  }

  const pCross = perLook.reduce((a, b) => a + b, 0);
  const pFutility = perLookFut.reduce((a, b) => a + b, 0);
  let eInfoFrac = 0;
  for (let k = 0; k < K; k++) eInfoFrac += t[k] * (perLook[k] + perLookFut[k]);
  eInfoFrac += t[K - 1] * (1 - pCross - pFutility); // never crossed either → reach the final look
  return { pCross, perLook, eInfoFrac, pFutility, perLookFut };
}

// Trapezoidal integral of density g over x ≥ cutoff, partial cell at the exact cutoff by linear interp.
function trapMassAbove(g: number[], x: number[], h: number, cutoff: number): number {
  const last = g.length - 1;
  if (cutoff <= x[0]) {
    let s = 0.5 * (g[0] + g[last]);
    for (let i = 1; i < last; i++) s += g[i];
    return s * h;
  }
  if (cutoff >= x[last]) return 0;
  const i0 = Math.min(last, Math.max(1, Math.ceil((cutoff - x[0]) / h)));
  const gCut = g[i0 - 1] + ((g[i0] - g[i0 - 1]) * (cutoff - x[i0 - 1])) / h;
  let s = 0.5 * (gCut + g[i0]) * (x[i0] - cutoff);
  for (let i = i0; i < last; i++) s += 0.5 * (g[i] + g[i + 1]) * h;
  return s;
}

// Trapezoidal integral of density g over x ≤ cutoff (the futility lower barrier), mirroring above.
function trapMassBelow(g: number[], x: number[], h: number, cutoff: number): number {
  const last = g.length - 1;
  if (cutoff >= x[last]) {
    let s = 0.5 * (g[0] + g[last]);
    for (let i = 1; i < last; i++) s += g[i];
    return s * h;
  }
  if (cutoff <= x[0]) return 0;
  const i0 = Math.min(last - 1, Math.max(0, Math.floor((cutoff - x[0]) / h))); // largest index with x[i0] ≤ cutoff
  let s = 0;
  for (let i = 0; i < i0; i++) s += 0.5 * (g[i] + g[i + 1]) * h;
  const gCut = g[i0] + ((g[i0 + 1] - g[i0]) * (cutoff - x[i0])) / h;
  s += 0.5 * (g[i0] + gCut) * (cutoff - x[i0]);
  return s;
}

const shapeFor = (spending: SpendingFunction) => (tk: number) => (spending === "OBF" ? 1 / Math.sqrt(tk) : 1);

// Solve the family constant C so P(cross efficacy ever | H0) = totalAlpha, OPTIONALLY with a futility
// lower barrier active (binding). Monotone decreasing in C → bisection. futZ undefined → efficacy-only.
function solveEfficacyConstant(totalAlpha: number, t: number[], shape: (tk: number) => number, M: number, futZ?: number[]): number {
  let loC = 0.3, hiC = 10;
  for (let it = 0; it < 80; it++) {
    const midC = 0.5 * (loC + hiC);
    const a = crossing(t.map((tk) => midC * shape(tk)), t, 0, M, futZ).pCross;
    if (a > totalAlpha) loC = midC;
    else hiC = midC;
  }
  return 0.5 * (loC + hiC);
}

// EFFICACY-ONLY (Phase 2). UNCHANGED — this is the function the efficacy path calls; it must stay
// byte-identical (the efficacy-unchanged regression). No futility barrier.
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

// β-spending function: cumulative type-II error spent by information time t (Lan-DeMets forms).
function betaSpendCumulative(shape: SpendingFunction, beta: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return beta;
  if (shape === "OBF") return Math.min(beta, 2 * (1 - normalCDF(normalInv(1 - beta / 2) / Math.sqrt(t))));
  return Math.min(beta, beta * Math.log(1 + (Math.E - 1) * t)); // POCOCK
}

// Sequentially solve the β-spending futility Z-boundaries under the design alternative ξ_design, given
// the efficacy boundaries. The FINAL analysis is decisive: a_K = c_K (no gap — every trajectory ends
// in success or failure). Interim a_k spends the β increment; monotone in a_k → bisection.
function solveFutilityZ(effZ: number[], t: number[], driftDesign: number, beta: number, futShape: SpendingFunction, M: number): number[] {
  const K = t.length;
  const aZ = new Array<number>(K).fill(-Infinity);
  for (let k = 0; k < K - 1; k++) {
    const target = betaSpendCumulative(futShape, beta, t[k]);
    let lo = -10, hi = effZ[k] - 1e-6; // futility strictly below efficacy
    for (let it = 0; it < 45; it++) {
      const mid = 0.5 * (lo + hi);
      aZ[k] = mid;
      const r = crossing(effZ, t, driftDesign, M, aZ);
      let cum = 0;
      for (let j = 0; j <= k; j++) cum += r.perLookFut[j];
      if (cum > target) hi = mid;
      else lo = mid;
    }
    aZ[k] = 0.5 * (lo + hi);
  }
  aZ[K - 1] = effZ[K - 1]; // decisive final look
  return aZ;
}

// Resolve efficacy + futility Z-boundaries for a β-spending design.
//   NON-BINDING: efficacy = the efficacy-only boundaries (BYTE-IDENTICAL — same solver), futility
//     β-spent under ξ_design; type-I claim = the efficacy-only α (futility is advisory).
//   BINDING: fixed-point (efficacy ⇄ futility) re-solving the efficacy constant LOWER under H0 WITH the
//     futility barrier active, so P(cross efficacy | H0) returns to exactly α. achievedAlpha is the
//     verified H0 type-I after convergence (the caller asserts ≈ α).
const M_SOLVE = 257; // iterative solves (fast); final assert refines at M_FINAL
const M_FINAL = 513;
export function resolveFutilityDesign(
  totalAlpha: number,
  lookFractions: number[],
  effSpending: SpendingFunction,
  fut: FutilityConfig,
  driftDesign: number,
): { effZ: number[]; futZ: number[]; achievedAlpha: number; binding: boolean } {
  const t = normalizeLooks(lookFractions);
  const effShape = shapeFor(effSpending);

  if (!fut.binding) {
    const effZ = sequentialBoundaries(totalAlpha, lookFractions, effSpending).zBoundaries; // UNCHANGED efficacy
    const futZ = solveFutilityZ(effZ, t, driftDesign, fut.beta, fut.spending, M_FINAL);
    // non-binding type-I ignores futility (advisory) → the efficacy-only α
    const achievedAlpha = crossing(effZ, t, 0, M_FINAL).pCross;
    return { effZ, futZ, achievedAlpha, binding: false };
  }

  // BINDING fixed point.
  let C = solveEfficacyConstant(totalAlpha, t, effShape, M_SOLVE);
  let effZ = t.map((tk) => C * effShape(tk));
  let futZ = solveFutilityZ(effZ, t, driftDesign, fut.beta, fut.spending, M_SOLVE);
  for (let outer = 0; outer < 8; outer++) {
    C = solveEfficacyConstant(totalAlpha, t, effShape, M_SOLVE, futZ);
    const newEff = t.map((tk) => C * effShape(tk));
    futZ = solveFutilityZ(newEff, t, driftDesign, fut.beta, fut.spending, M_SOLVE);
    const delta = Math.max(...newEff.map((z, k) => Math.abs(z - effZ[k])));
    effZ = newEff;
    if (delta < 1e-5) break;
  }
  // final refine + verified type-I at high resolution
  C = solveEfficacyConstant(totalAlpha, t, effShape, M_FINAL, futZ);
  effZ = t.map((tk) => C * effShape(tk));
  futZ = solveFutilityZ(effZ, t, driftDesign, fut.beta, fut.spending, M_FINAL);
  const achievedAlpha = crossing(effZ, t, 0, M_FINAL, futZ).pCross;
  return { effZ, futZ, achievedAlpha, binding: true };
}

// Crossing probability / expected info fraction for ALREADY-resolved boundaries (per-θ table + E[N] in
// computeStageRR). OPTIONAL futility barrier aZ — absent → efficacy-only (byte-identical to Phase 2).
export function pCrossGivenBoundaries(zBoundaries: number[], lookFractions: number[], drift: number, aZ?: number[]): number {
  return crossing(zBoundaries, normalizeLooks(lookFractions), drift, 513, aZ).pCross;
}
export function expectedInfoFractionGivenBoundaries(zBoundaries: number[], lookFractions: number[], drift: number, aZ?: number[]): number {
  return crossing(zBoundaries, normalizeLooks(lookFractions), drift, 513, aZ).eInfoFrac;
}
