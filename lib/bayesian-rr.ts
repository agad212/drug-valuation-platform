// ═══════════════════════════════════════════════════════════════════════════
// Bayesian Response-Rate Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Replaces the heuristic stage-update (MSS +10, σ² ×0.65) with true
// likelihood-weighted Bayesian posterior updating over response-rate
// distributions.
//
// KEY IDEA: instead of an abstract 0-2 "effect strength" scale, this
// module works in RESPONSE RATE space (θ ∈ [0, 1]) — the drug's true
// probability of producing a response in a patient. We represent the
// prior as a mixture of Beta distributions (natural for proportions,
// bounded 0-1), compute trial success probability by numerically
// integrating over the prior, and update via Bayes' rule:
//
//   posterior(θ) ∝ prior(θ) × P(success | θ, trial design)
//
// The tightening EMERGES from the math: a small n=45 single-arm trial
// has a wide, weak likelihood → posterior barely moves. A large n=220
// RCT has a sharp likelihood → posterior tightens substantially.
//
// This file is PURE MATH: no API calls, no React, no side effects.
// ═══════════════════════════════════════════════════════════════════════════

import { normalCDF, enrichEffectPrior, DEFAULT_ENRICHMENT_LIFT } from "./effect-prior";
import type { EffectPriorMixture } from "./effect-prior";
import { tteEventsFromAccrual, schoenfeldZ, type TteAccrual } from "./tte-power";
import { sequentialBoundaries, pCrossGivenBoundaries, expectedInfoFractionGivenBoundaries, resolveFutilityDesign, type SpendingFunction } from "./sequential-power";
import type {
  EndpointType,
  DesignType,
  PopulationType,
  RegulatoryContext,
} from "./ptrs-trial";

// ─── Types ───────────────────────────────────────────────────────────────

/** One component of a Beta mixture distribution over response rate θ ∈ [0,1]. */
export type BetaComponent = {
  w: number;     // mixture weight (all weights sum to 1)
  alpha: number; // Beta shape parameter α (controls left tail)
  beta: number;  // Beta shape parameter β (controls right tail)
  // mean = α/(α+β), variance = αβ/((α+β)²(α+β+1))
  // α+β = "concentration" — higher = more confident
};

/** A mixture of 1-2 Beta distributions over θ ∈ [0,1]. */
export type BetaMixture = BetaComponent[];

/**
 * A discretized probability density over θ ∈ [0,1].
 * theta[i] and density[i] are matched arrays of GRID_SIZE points.
 * density is normalized so that Σ density[i] × Δθ ≈ 1.
 */
export type RRGrid = {
  theta: number[];
  density: number[];
};

/** Probability mass in three response-rate bands. Sum ≈ 1. */
export type RRBands = {
  belowThreshold: number; // θ < nullRR
  modest: number;         // nullRR ≤ θ < nullRR + AVERAGE_EVIDENCE_DELTA_RR (a below-average margin)
  strong: number;         // θ ≥ nullRR + AVERAGE_EVIDENCE_DELTA_RR (above the average-evidence margin)
};

/** Trial design parameters needed for the power calculation. */
export type RRTrialDesign = {
  designType: DesignType;
  endpointType: EndpointType;
  populationType: PopulationType;
  regulatoryContext: RegulatoryContext;
  // G2 Phase 2a (CONTINUOUS family): when present, rrTrialPower uses native two-sample
  // z-power instead of the proportion/RR path. `outcomeSd` + `expectedDelta` are the sourced
  // native-scale stats; `dScale` is the boundary calibration computed ONCE in computeStageRR
  // (from the prior mean + effectiveNull) — precision only; the effect stays in the prior.
  // Absent → proportion path (byte-identical). See CONTINUOUS-FAMILY POWER below.
  continuous?: { outcomeSd: number; expectedDelta: number; dScale?: number };

  // ── Layer 1 DESIGN SPEC (design-aware power). All OPTIONAL; absent → today's single-look path,
  //    byte-identical. alpha + tte carry real power math this pass; sequential/adaptive/bayesian are
  //    DEFINED so Layer 2 can later populate them, but are carried-but-INERT (no power math yet).
  //    Deterministic only — no LLM; a design parameter sets precision/bar/structure, never effect
  //    magnitude (that stays in the prior over θ, integrated in computeStageSuccess).

  // Family 2 — free significance level. Present → z_α = Φ⁻¹(1 − α[/2]) (see computeZAlpha); absent →
  // the regulatoryContext category (Z_ALPHA). REPLACES the category, never stacks.
  alpha?: { value: number; sided?: 1 | 2; multiplicity?: number };

  // Family 3 — native TTE (Schoenfeld log-rank), RCT this pass. `expectedHR` is anchored to the prior
  // mean's margin via `hrScale` (resolved in computeStageRR) — a monotone reparam of (θ−null), NOT a
  // new effect. `events` is INFORMATION (√d): an explicit count or derived from the accrual sub-model.
  // Gated on the RESOLVED hrScale, NEVER on isTimeToEvent (that would move TTX). Replaces the RR-proxy
  // for RCT-TTE; single-arm/basket TTE is not resolved this pass → stays on the RR-proxy, unchanged.
  tte?: {
    expectedHR: number;
    events?: number;
    accrual?: TteAccrual;
    hrScale?: number; // resolved in computeStageRR — precision/anchor only
    eventsResolved?: number; // resolved in computeStageRR
  };

  // Family 1 — group-sequential / interim (Phase 2, efficacy-only). lookFractions + spending define
  // the efficacy boundaries; zBoundaries + pCrossTable are RESOLVED in computeStageRR (θ-independent
  // boundaries + a drift→P(cross) interpolation table). Futility is a fast-follow (not this pass).
  sequential?: {
    lookFractions: number[];
    spending?: "OBF" | "POCOCK" | "LDL"; // LDL reserved (fast-follow) → falls back to OBF this pass
    // Futility (β-spending). binding re-solves the efficacy bar so type-I stays α; non-binding is
    // advisory (efficacy untouched). conditional-power is deferred (fast-follow) → inert + flag.
    futility?: {
      futilityType: "beta-spending" | "conditional-power" | "none";
      binding?: boolean;
      beta?: number; // total type-II error spent on futility (default 0.10)
      spending?: "OBF" | "POCOCK"; // β-spending shape (default OBF)
    };
    zBoundaries?: number[]; // resolved: efficacy boundaries (θ-independent)
    pCrossTable?: { drift: number[]; p: number[] }; // resolved: drift→P(cross) interpolation table
  };
  adaptive?: { kind?: string; [k: string]: unknown }; // FLAG-ONLY (later)
  // Family 5 — single-look Bayesian posterior-threshold (Phase 2, proportion family). analysisPrior is
  // a DECISION-RULE Beta {a,b} — NEVER the effect mixture (enforced by type; a mixture cannot reach it).
  // kStar is RESOLVED in computeStageRR. predictive (sequential PP) is deferred.
  bayesian?: {
    refTheta?: number;
    postThreshold?: number;
    analysisPrior?: { a: number; b: number };
    predictive?: unknown; // sequential predictive-probability (deferred → rides on Family 1)
    kStar?: number; // resolved in computeStageRR (proportion family only)
  };
};

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * Minimum clinically meaningful response rate for the success threshold.
 *
 * Even if the SOC/control rate is very low (e.g. 2% spontaneous clearance),
 * a regulatory body won't approve a drug for barely beating zero. The trial
 * must show a CLINICALLY MEANINGFUL effect. This floor ensures the power
 * calculation doesn't produce absurd near-certainty from a trivially low bar.
 *
 * For RR endpoints: floor at 10% (a drug showing <10% RR is rarely approvable).
 * For TTE endpoints proxied through RR: floor at 25% (harder bar — the proxy
 * must reflect the difficulty of the actual time-to-event endpoint).
 */
export const MEANINGFUL_RR_FLOOR = 0.10;
export const TTE_PROXY_RR_FLOOR = 0.25;

/**
 * Compute the effective threshold for a trial, applying clinical
 * meaningfulness floors. The raw SOC rate is the statistical null;
 * the effective threshold is what the drug must actually beat for
 * the trial result to be considered CLINICALLY MEANINGFUL for
 * registration.
 */
export function effectiveThreshold(
  rawNullRR: number,
  isTimeToEvent: boolean = false,
): number {
  const floor = isTimeToEvent ? TTE_PROXY_RR_FLOOR : MEANINGFUL_RR_FLOOR;
  return Math.max(rawNullRR, floor);
}

export const GRID_SIZE = 1001;
const GRID_MIN = 0.001;
const GRID_MAX = 0.999;
const GRID_STEP = (GRID_MAX - GRID_MIN) / (GRID_SIZE - 1);

// Base re-pin (capstone): POP_N_FACTOR (the base-path biomarker effective-n boost, was
// biomarker_selected 1.3 / broad 1.0 / rare_small 0.8) is DELETED. Biomarker enrichment now
// runs the SAME upstream mechanism on both axes — effect-prior.ts enrichEffectPrior (a
// truth-curve μ-shift), applied PER-STAGE in dev-plan.ts computeDevPlan (confined to the
// enriched stage, non-propagating). Population type no longer scales trial power; nEff = n.
// This retires the last base/scenario split — one unified engine — and moves the tripwires
// (re-locked once against the unified engine).

// Endpoint-semantics pass: the a-priori categorical ENDPOINT_N_FACTOR (hard 1.2 /
// surrogate 1.0 / pro 0.7) was DELETED. It was a wrong-signed a-priori haircut on trial
// power ("hard = objectively measured → more effective-n"), the same anti-pattern as the
// retired peak ×0.70 and biomarker P-multiplier — and it double-encoded a clinically
// HARDER endpoint as EASIER. Endpoint TYPE no longer touches trial power at all.
//
// Endpoint now affects TRIAL P (achievability) ONLY through the real quantitative channels
// the sim already integrates: n, nullResponseRate (endpoint-pinned control/SOC rate),
// comparatorSigma2 (measurement / historical-benchmark uncertainty), designType (arm
// allocation), isTimeToEvent (RR-proxy floor here + the surrogate→TTE translation-variance
// bump in dev-plan.ts), and the effect-prior mixture. The ONLY legitimate CATEGORICAL
// endpoint rule — regulatory ACCEPTABILITY (will the agency accept this endpoint as an
// approval basis even if the trial hits it) — lives on the graded reg scale in dev-plan.ts
// deriveRegConfidence, orthogonal to trial P. With the factor gone there is no categorical
// trial-P term left for it to collide with.

// ─── CONTINUOUS-FAMILY POWER (G2 Phase 2a) ───────────────────────────────────
// A continuous endpoint (FVC decline, BCVA letters, 6MWD, HbA1c) has its own outcome SD
// and effect scale — the proportion sim's binomial variance is a fabricated stand-in.
// When a stage carries sourced native-scale stats (outcomeSd + expectedDelta), rrTrialPower
// computes the real two-sample z-test power: power(θ) = Φ(d(θ)·√(nArm/2) − z_α).
//   • EFFECT stays in the prior: d(θ) is proportional to the prior's θ-margin (θ − null),
//     integrated over the prior in computeStageSuccess — the sim never invents the effect.
//   • outcomeSd is the PRECISION knob only: d = (native effect)/SD, so varying SD alone
//     moves power via se, leaving the prior's effect untouched (the anti-double-count proof).
//   • expectedDelta re-expresses the prior's expected effect in native units so SD can
//     standardize it; the calibration `dScale` (computed once in computeStageRR) anchors
//     d = expectedDelta/outcomeSd at the prior mean and scales linearly with (θ − null).
// Divergence from the old μ/2 proxy is EXPECTED and correct (the proxy fabricated binomial
// variance); it is labeled, never tuned to reproduce the proxy. Absent stats → proportion
// path, byte-identical. TTE family (HR + #events / Schoenfeld) is deferred to Phase 2b.
const CONTINUOUS_D_CAP = 3.0;        // Cohen's d ceiling — d>3 is implausible; keeps power bounded
const CONTINUOUS_MIN_MARGIN = 0.02;  // floor for (priorMean − null) so the calibration can't blow up
const TTE_LN_HR_CAP = 2.0;           // |ln HR| ceiling (HR≈0.14) — keeps native-TTE power bounded

// Regulatory context → one-sided significance level z-value
// BTD/orphan programs get regulatory flexibility (lower bar).
// Confirmatory trials face a stricter bar.
const Z_ALPHA: Record<RegulatoryContext, number> = {
  btd: 1.28,           // α ≈ 0.10 one-sided
  orphan: 1.28,
  btd_orphan: 1.28,
  accelerated: 1.28,
  standard: 1.645,     // α = 0.05 one-sided
  fast_track: 1.645,   // Fast Track does NOT ease the statistical bar (== standard)
  confirmatory: 1.96,  // α = 0.025 one-sided
};

// ─── Layer 1, Family 2: alpha-as-parameter ─────────────────────────────────────
// z_α is the ONLY significance channel. Today it's a regulatoryContext CATEGORY lookup (above); with
// a free alpha it becomes a parameter. computeZAlpha REPLACES the category when design.alpha is
// present, and returns the IDENTICAL category expression when it is absent (the FROZEN invariant).
// alpha moves the BAR (difficulty), never the effect — same channel as the category, now continuous.

// Inverse standard-normal CDF (Acklam's rational approximation; |abs error| < 1.15e-9).
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

// Free alpha → z_α. Bonferroni-split by `multiplicity` if given; one- or two-sided.
function zFromAlpha(alpha: number, sided: 1 | 2 = 1, multiplicity?: number): number {
  const m = multiplicity && multiplicity > 0 ? multiplicity : 1;
  const aEff = Math.max(1e-9, Math.min(0.5, alpha / m));
  const tail = sided === 2 ? aEff / 2 : aEff;
  return normalInv(1 - tail);
}

// The significance bar for a stage: free alpha REPLACES the category (never stacks); absent → the
// EXACT category expression used before Layer 1. This is what keeps FROZEN assets byte-identical.
function computeZAlpha(design: RRTrialDesign): number {
  if (design.alpha != null && Number.isFinite(design.alpha.value)) {
    return zFromAlpha(design.alpha.value, design.alpha.sided ?? 1, design.alpha.multiplicity);
  }
  return Z_ALPHA[design.regulatoryContext] ?? 1.645;
}

// ─── Layer 1 Phase 2, Family 5: single-look Bayesian posterior-threshold ────────
// Regularized incomplete beta I_x(a,b) — Numerical Recipes continued fraction. Serves BOTH the
// posterior tail P(θ>θ0 | Beta) AND the binomial power tail P(X≥k | n,θ) = I_θ(k, n−k+1). Validated
// as a PRIMITIVE before anything consumes it (I_{0.5}(a,a)=0.5, I_x(1,1)=x, I_{0.5}(15,6)=0.020695).
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b) ∈ [0,1]. */
export function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

// P(θ > θ0 | k responders in n) under a Beta(a,b) ANALYSIS prior (a decision-rule parameter — NEVER
// the effect mixture) = P(Beta(a+k, b+n−k) > θ0) = 1 − I_{θ0}(a+k, b+n−k).
function posteriorExceed(k: number, n: number, theta0: number, prior: { a: number; b: number }): number {
  return 1 - betai(prior.a + k, prior.b + (n - k), theta0);
}

// Smallest responder count k in [0,n] with posterior P(θ>θ0) ≥ c (monotone increasing in k → binary
// search). Returns n+1 when even all-responders can't clear c (the design can never declare success).
export function bayesianCritK(n: number, theta0: number, c: number, prior: { a: number; b: number }): number {
  if (posteriorExceed(n, n, theta0, prior) < c) return n + 1;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (posteriorExceed(mid, n, theta0, prior) >= c) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Frequentist power of the Bayesian rule at true θ: P(X ≥ k* | Binom(n,θ)) = I_θ(k*, n−k*+1). Effect
// enters ONLY through θ here; the analysis prior already resolved to k* (single-locus).
export function bayesianThresholdPower(theta: number, n: number, kStar: number): number {
  if (kStar > n) return 0;
  if (kStar <= 0) return 1;
  return betai(kStar, n - kStar + 1, theta);
}

// Linear interpolation on the precomputed drift→P(cross) table (built once per stage in
// computeStageRR; the sequential boundaries are θ-independent, P(cross) is a smooth monotone
// function of the drift). O(log n) lookup per θ.
function interpPCross(table: { drift: number[]; p: number[] }, drift: number): number {
  const { drift: xs, p: ys } = table;
  if (drift <= xs[0]) return ys[0];
  if (drift >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= drift) lo = mid;
    else hi = mid;
  }
  const w = (drift - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + w * (ys[hi] - ys[lo]);
}

// ─── Math primitives ─────────────────────────────────────────────────────

/**
 * Natural log of the Gamma function, via the Lanczos approximation.
 * Accurate to ~15 digits for positive real z.
 * See: https://en.wikipedia.org/wiki/Lanczos_approximation
 */
export function lnGamma(z: number): number {
  if (z <= 0) return Infinity;
  if (z < 0.5) {
    // Reflection formula: Γ(z) = π / (sin(πz) × Γ(1-z))
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Natural log of the Beta function: B(a,b) = Γ(a)Γ(b)/Γ(a+b). */
export function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/**
 * Log of the Beta PDF at x, with shape parameters a and b.
 * Returns -Infinity at the boundaries (x=0 or x=1) when a<1 or b<1.
 */
function lnBetaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return -Infinity;
  return (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lnBeta(a, b);
}

/** Beta PDF value at x. Uses log-space to avoid overflow. */
export function betaPdf(x: number, a: number, b: number): number {
  const lp = lnBetaPdf(x, a, b);
  return lp > -700 ? Math.exp(lp) : 0;
}

/**
 * Log of the binomial coefficient: ln(n choose k).
 * Uses lnGamma: ln(C(n,k)) = lnGamma(n+1) - lnGamma(k+1) - lnGamma(n-k+1).
 */
export function lnChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
}

// ─── Gaussian ↔ Beta conversion ──────────────────────────────────────────
//
// The evidence integration engine (effect-prior.ts) works in Gaussian space with mu ∈ [0, 2] and
// sigma2 ∈ [0.05, 0.8], where mu is a RELATIVE effect-strength multiplier: 1.0 = "average confirming
// evidence" (the analog/clinical chain emits ~1.1–1.5 for above-average evidence). We convert to
// response-rate space at the boundary, ANCHORED ON THE COMPARATOR:
//
//   mean_rr = anchorNull + mu × AVERAGE_EVIDENCE_DELTA_RR
//   var_rr  = sigma2 × AVERAGE_EVIDENCE_DELTA_RR²      (affine y = a + Δx ⇒ var scales by Δ²)
//
// So a drug with average evidence (mu = 1.0) is expected to clear its comparator by the minimum
// clinically meaningful margin, and mu scales that margin linearly. THE 2.2 FIX: the previous map read
// mu as an ABSOLUTE response rate (mean_rr = mu/2), asserting an average drug has a 50% RR against
// nulls of 0.10–0.20 — a built-in ~30-point effect before any evidence, which saturated raw stage
// success at 93–100% and left the base-rate ceilings capping an already-broken number. The suite's own
// G2-2a log measured the divergence: proportion proxy P=0.654 vs native continuous P=0.186 for the
// same stage. Anchoring on the comparator makes the proxy consistent with the native-scale families
// (continuous/TTE), which already scale power by (θ − null).
//
// AVERAGE_EVIDENCE_DELTA_RR = 0.10 is MEANINGFUL_RR_FLOOR's concept re-used: the codebase already
// pins 0.10 as the minimum clinically meaningful response margin. Validation (literature-anchored,
// not target-tuned): at typical trial sizes this mapping reproduces documented phase base rates
// unprompted — Phase 3 (null .20, n=280): Δ .113 ⇒ power ≈ 58% vs BIO/Informa Phase 3 ~58–60%;
// Phase 2b (null .15, n=80) ⇒ ≈ 35% vs Phase 2 ~30–35%.
export const AVERAGE_EVIDENCE_DELTA_RR = 0.10;

/**
 * Build Beta(alpha, beta) from a target mean and variance on [0, 1]. The single primitive BOTH sides
 * of the comparison use — the drug prior (via gaussianToBeta's anchored map) and the comparator
 * distribution (directly, in makeComparatorGrid). Having one primitive removes the old bidirectional
 * μ-space round-trip (the comparator used to be built by INVERTING the drug-side map).
 *
 *   concentration = mean(1-mean)/var - 1   (how peaked the Beta is)
 *   alpha = mean × concentration; beta = (1-mean) × concentration
 */
export function betaFromMeanVar(meanIn: number, varIn: number): { alpha: number; beta: number } {
  const mean = Math.max(0.01, Math.min(0.99, meanIn));
  const varRR = Math.max(1e-6, varIn);

  // If variance is too large for a Beta (var ≥ mean(1-mean)), clamp concentration
  const maxVar = mean * (1 - mean);
  const effectiveVar = Math.min(varRR, maxVar * 0.95); // ensure concentration > 0
  const concentration = Math.max(2, maxVar / effectiveVar - 1);

  return {
    alpha: Math.max(0.5, mean * concentration),
    beta: Math.max(0.5, (1 - mean) * concentration),
  };
}

/**
 * Convert a single Gaussian component (mu, sigma2) from the effect-prior engine into Beta
 * parameters, anchored on the comparator (see the header above):
 *   mean_rr = anchorNull + mu × AVERAGE_EVIDENCE_DELTA_RR
 *   var_rr  = sigma2 × AVERAGE_EVIDENCE_DELTA_RR²
 * `anchorNull` is the FLOORED null (an input-only quantity — never the effectiveNull that depends on
 * prior moments, which would be circular).
 */
export function gaussianToBeta(mu: number, sigma2: number, anchorNull: number): { alpha: number; beta: number } {
  const mean = anchorNull + mu * AVERAGE_EVIDENCE_DELTA_RR;
  const varRR = sigma2 * AVERAGE_EVIDENCE_DELTA_RR * AVERAGE_EVIDENCE_DELTA_RR;
  return betaFromMeanVar(mean, varRR);
}

/**
 * Convert a full Gaussian mixture (from effect-prior.ts) to a Beta mixture, anchored on the
 * comparator. Each component is converted independently; weights are preserved.
 */
export function mixtureToBeta(mixture: EffectPriorMixture, anchorNull: number): BetaMixture {
  return mixture.map((c) => {
    const { alpha, beta } = gaussianToBeta(c.mu, c.sigma2, anchorNull);
    return { w: c.w, alpha, beta };
  });
}

// ─── Grid operations ─────────────────────────────────────────────────────

/** Create the standard θ grid: 1001 evenly spaced points on [0.001, 0.999]. */
export function makeGrid(): number[] {
  const theta: number[] = new Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) {
    theta[i] = GRID_MIN + i * GRID_STEP;
  }
  return theta;
}

/**
 * Evaluate a Beta mixture PDF on the standard grid.
 * Returns normalized density (integrates to ~1 over [0,1]).
 */
export function betaToGrid(mixture: BetaMixture, gridSize = GRID_SIZE): RRGrid {
  const theta = makeGrid();
  const density: number[] = new Array(gridSize);

  for (let i = 0; i < gridSize; i++) {
    let d = 0;
    for (const c of mixture) {
      d += c.w * betaPdf(theta[i], c.alpha, c.beta);
    }
    density[i] = d;
  }

  // Normalize so that Σ density[i] × Δθ ≈ 1
  const total = density.reduce((s, d) => s + d, 0) * GRID_STEP;
  if (total > 1e-15) {
    const scale = 1 / total;
    for (let i = 0; i < gridSize; i++) density[i] *= scale;
  }

  return { theta, density };
}

/**
 * Compute mean and variance of a discretized density on the θ grid.
 */
export function gridMoments(grid: RRGrid): { mean: number; variance: number } {
  let mean = 0;
  let meanSq = 0;
  for (let i = 0; i < grid.theta.length; i++) {
    const w = grid.density[i] * GRID_STEP;
    mean += grid.theta[i] * w;
    meanSq += grid.theta[i] * grid.theta[i] * w;
  }
  return { mean, variance: Math.max(0, meanSq - mean * mean) };
}

/**
 * Convert a discretized posterior grid back to a Gaussian mixture
 * (for passing to the next stage in the existing dev-plan pipeline).
 *
 * For nComponents=1: computes overall mean/variance from the grid.
 * For nComponents=2: splits at the density valley between modes,
 * computes per-component moments (approximate but sufficient).
 */
export function gridToGaussianMixture(
  grid: RRGrid,
  nComponents: number = 1,
  anchorNull: number = 0,
): EffectPriorMixture {
  // EXACT INVERSE of the comparator-anchored forward map (gaussianToBeta):
  //   mu = (mean_rr − anchorNull) / Δ    (clamped ≥ 0 — μ-space has no below-comparator state)
  //   sigma2 = var_rr / Δ²
  // This is how the posterior PROPAGATES across stages: μ is the portable relative-effect quantity,
  // so a posterior margin earned at stage k re-expresses over stage k+1's (possibly different)
  // comparator. THE 2.2 COLLAPSE BUG lived here: the forward map was re-anchored but this inverse
  // still used the old absolute mu = mean×2, so each stage hand-off roughly halved the margin and
  // multi-stage P(approval) collapsed (tau hit 0.0099 mid-refactor).
  const toMu = (mean: number) => Math.max(0, (mean - anchorNull) / AVERAGE_EVIDENCE_DELTA_RR);
  const toSigma2 = (variance: number) =>
    Math.max(1e-6, variance / (AVERAGE_EVIDENCE_DELTA_RR * AVERAGE_EVIDENCE_DELTA_RR));

  if (nComponents <= 1 || grid.theta.length === 0) {
    const { mean, variance } = gridMoments(grid);
    return [{
      w: 1,
      mu: toMu(mean),
      sigma2: toSigma2(variance),
    }];
  }

  // 2-component: find the valley (minimum density between two peaks)
  const n = grid.theta.length;
  let valleyIdx = Math.floor(n / 2);
  let valleyVal = Infinity;

  // Search the middle 60% of the grid for the valley
  const searchStart = Math.floor(n * 0.2);
  const searchEnd = Math.floor(n * 0.8);
  for (let i = searchStart; i < searchEnd; i++) {
    if (grid.density[i] < valleyVal) {
      valleyVal = grid.density[i];
      valleyIdx = i;
    }
  }

  // Split into two halves and compute weighted moments for each
  const components: EffectPriorMixture = [];
  for (const [start, end] of [[0, valleyIdx], [valleyIdx, n]] as const) {
    let mass = 0, m1 = 0, m2 = 0;
    for (let i = start; i < end; i++) {
      const w = grid.density[i] * GRID_STEP;
      mass += w;
      m1 += grid.theta[i] * w;
      m2 += grid.theta[i] * grid.theta[i] * w;
    }
    if (mass < 1e-10) continue;
    const mean = m1 / mass;
    const variance = Math.max(1e-6, m2 / mass - mean * mean);
    components.push({
      w: mass,
      mu: toMu(mean),
      sigma2: toSigma2(variance),
    });
  }

  // Normalize weights
  const totalW = components.reduce((s, c) => s + c.w, 0);
  for (const c of components) c.w /= totalW;

  return components.length > 0 ? components : [{ w: 1, mu: 1.0, sigma2: 0.2 }];
}

/**
 * Downsample a full 1001-point grid to ~nPoints for UI chart display.
 * Returns plain arrays suitable for Recharts.
 */
export function downsampleGrid(
  grid: RRGrid,
  nPoints: number = 60,
): { theta: number[]; density: number[] } {
  const step = Math.max(1, Math.floor(grid.theta.length / nPoints));
  const theta: number[] = [];
  const density: number[] = [];
  for (let i = 0; i < grid.theta.length; i += step) {
    theta.push(grid.theta[i]);
    density.push(grid.density[i]);
  }
  return { theta, density };
}

// ─── Trial success likelihood (response-rate version) ────────────────────
//
// P(trial success | θ, trial design) = statistical POWER of the trial
// to detect a true response rate θ against a null hypothesis of θ₀.
//
// This is the standard power formula from biostatistics:
//   Single-arm: compare observed RR to historical control θ₀
//   RCT: compare treatment arm to control arm
//
// The key insight: a small n gives a WIDE sampling distribution, so
// P(success|θ) is moderate even for good θ. A large n gives a NARROW
// sampling distribution, so P(success|θ) is near 1 for good θ and
// near 0 for bad θ. This is what makes the Bayesian posterior tighten
// more after large trials.

/**
 * Compute P(trial success | θ_true, trial design) — the statistical
 * power of the trial at a given true response rate θ.
 *
 * @param theta             True response rate (0-1)
 * @param nullRR            Null/control response rate (historical control or SOC)
 * @param n                 Total sample size
 * @param design            Trial design parameters affecting n_effective and z_alpha
 * @param comparatorSigma2  Variance of the historical control estimate (0 for RCTs with
 *                          concurrent control; >0 for single-arm vs uncertain historical
 *                          benchmark). Widens the success denominator, correctly making
 *                          single-arm comparisons against uncertain baselines less confident.
 */
export function rrTrialPower(
  theta: number,
  nullRR: number,
  n: number,
  design: RRTrialDesign,
  comparatorSigma2: number = 0,
  // Fix C: cap single-arm P(trial success) at the equivalent RCT (registration
  // conclusiveness). Default true for the success integral; posteriorAfterSuccess
  // passes false so the drug's effect-ESTIMATE update reflects the trial's actual
  // single-arm measurement precision — capping it there would spuriously make a
  // small single-arm posterior tighter than a large RCT's (a separate quantity).
  capSingleArmToRct: boolean = true,
): number {
  if (theta <= 0 || theta >= 1) return theta >= 1 ? 1 : 0;
  if (n < 1) return 0;

  // Neither endpoint type nor population type scales trial power any more:
  // ENDPOINT_N_FACTOR (endpoint-semantics pass) and POP_N_FACTOR (base re-pin) are both
  // DELETED. Biomarker enrichment is a per-stage prior μ-shift (enrichEffectPrior, applied
  // in computeDevPlan), not an effective-n factor here. Effective n = the trial's n.
  const nEff = n;

  const zA = computeZAlpha(design);

  // Layer 1 Phase 2: single-look BAYESIAN posterior-threshold REPLACES the frequentist proportion
  // rule (kStar resolved in computeStageRR ONLY for the proportion family). Effect still enters only
  // through θ in the binomial tail. Absent → the frequentist family path below.
  if (design.bayesian?.kStar != null) {
    return bayesianThresholdPower(theta, n, design.bayesian.kStar);
  }

  // ── Base single-look power over the endpoint family (Phase 1 — computations UNCHANGED, captured
  //    into a value so the Phase-2 group-sequential wrapper can compose over it). ──
  let basePower: number;
  if (design.continuous?.dScale != null) {
    // G2 Phase 2a: CONTINUOUS-family native power. Gated on the boundary calibration dScale.
    basePower = continuousStagePower(theta, nullRR, nEff, zA, design, capSingleArmToRct);
  } else if (design.tte?.hrScale != null) {
    // NATIVE-TTE (Schoenfeld). Gated on the RESOLVED hrScale (RCT only), NEVER on isTimeToEvent.
    basePower = tteStagePower(theta, nullRR, design, zA);
  } else if (design.designType === "rct") {
    basePower = twoProportionRctPower(theta, nullRR, nEff, zA, comparatorSigma2);
  } else {
    // Single-arm (or basket): one-proportion test vs historical control. comparatorSigma2 is the
    // historical-benchmark uncertainty. Capped at the RCT-equivalent (Fix C).
    const nSingleArm = design.designType === "basket" ? Math.max(1, nEff / 3) : Math.max(1, nEff);
    const seCrit = Math.sqrt((nullRR * (1 - nullRR)) / nSingleArm);
    const thetaCrit = nullRR + zA * seCrit;
    const seObs = Math.sqrt((theta * (1 - theta)) / nSingleArm + comparatorSigma2);
    const singleArmPower = seObs < 1e-10 ? (theta > thetaCrit ? 1 : 0) : normalCDF((theta - thetaCrit) / seObs);
    basePower = !capSingleArmToRct ? singleArmPower : Math.min(singleArmPower, twoProportionRctPower(theta, nullRR, nEff, zA, 0));
  }

  // Layer 1 Phase 2: GROUP-SEQUENTIAL wrapper. Gated on the RESOLVED pCrossTable (built in
  // computeStageRR from the θ-independent efficacy boundaries). Recovers the standardized drift
  // ξ = Φ⁻¹(basePower) + z_α and returns P(cross) — composing over proportion / continuous / native-
  // TTE base power alike (it reads only the scalar base power). Absent → basePower (byte-identical).
  if (design.sequential?.pCrossTable != null) {
    const bp = Math.min(1 - 1e-12, Math.max(1e-12, basePower));
    const drift = Math.min(20, Math.max(-20, normalInv(bp) + zA));
    return interpPCross(design.sequential.pCrossTable, drift);
  }

  return basePower;
}

// Two-proportion z-test power (equal allocation). For RCTs the control arm is measured
// in-trial; comparatorSigma2 adds any residual external-benchmark uncertainty (~0 for a
// proper concurrent-controlled RCT).
function twoProportionRctPower(
  theta: number, nullRR: number, nEff: number, zA: number, comparatorSigma2: number,
): number {
  const nArm = Math.max(1, nEff / 2);
  const se = Math.sqrt((theta * (1 - theta) + nullRR * (1 - nullRR)) / nArm + comparatorSigma2);
  if (se < 1e-10) return theta > nullRR ? 1 : 0;
  return normalCDF((theta - nullRR) / se - zA);
}

// CONTINUOUS-family native power (G2 Phase 2a). power(θ) = Φ(d(θ)·√(nArm/2) − z_α), a
// two-sample z-test on a mean. The standardized effect d(θ) comes from the PRIOR's θ-margin
// (θ − null), converted to native units and standardized by the sourced SD via the
// precomputed dScale = (expectedDelta/outcomeSd) / max(priorMean − null, MIN_MARGIN):
//   d(θ) = clamp( dScale · max(θ − null, 0), 0, D_CAP )
// so at θ = priorMean, d = expectedDelta/outcomeSd, and d scales linearly with the prior's
// margin. Effect lives in the prior (θ, integrated); outcomeSd is precision only (enters as
// se: d = effect/SD). designType sets nArm exactly as the proportion path (rct nEff/2;
// single-arm nEff, capped at the RCT-equivalent per Fix C; basket nEff/3).
function continuousStagePower(
  theta: number, nullRR: number, nEff: number, zA: number,
  design: RRTrialDesign, capSingleArmToRct: boolean,
): number {
  const dScale = design.continuous!.dScale!;
  const d = Math.max(0, Math.min(CONTINUOUS_D_CAP, dScale * Math.max(theta - nullRR, 0)));

  // Two-sample z-test power for per-arm size m: Φ(d·√(m/2) − z_α).
  const twoSample = (perArm: number) => normalCDF(d * Math.sqrt(Math.max(1, perArm) / 2) - zA);

  if (design.designType === "rct") {
    return twoSample(nEff / 2); // equal allocation, per-arm = nEff/2
  }

  // Single-arm / basket: one-sample z-test vs a historical mean (all n on treatment):
  // Z = d·√n → Φ(d·√n − z_α). Capped at the RCT-equivalent (Fix C parallel): a single-arm
  // design is never MORE conclusive than a concurrent-controlled RCT with the same patients.
  const nOne = design.designType === "basket" ? Math.max(1, nEff / 3) : Math.max(1, nEff);
  const oneSample = normalCDF(d * Math.sqrt(nOne) - zA);
  if (!capSingleArmToRct) return oneSample;
  return Math.min(oneSample, twoSample(nEff / 2));
}

// NATIVE-TTE (Schoenfeld log-rank) power(θ) for a 1:1 RCT — Layer 1, Family 3. The prior's θ-margin
// maps to a hazard ratio through the anchored hrScale (computeStageRR sets it so that at θ=priorMean,
// |ln HR| = |ln expectedHR|, exactly like the 2a continuous dScale): |ln HR(θ)| = hrScale·max(θ−null,0),
// capped. HR is thus a MONOTONE REPARAMETERISATION of the prior's margin, NOT a new effect; events
// (d, resolved once) is INFORMATION only, entering solely as √d inside schoenfeldZ. At θ ≤ null →
// HR = 1 → Z = −z_α → power = the type-I rate, as it must. The n used elsewhere describes patients;
// TTE power is driven by events, not n (no double-count).
function tteStagePower(theta: number, nullRR: number, design: RRTrialDesign, zA: number): number {
  const t = design.tte!;
  const lnHR = Math.min(TTE_LN_HR_CAP, t.hrScale! * Math.max(theta - nullRR, 0));
  const hrTheta = Math.exp(-lnHR); // benefit → HR ≤ 1; |ln HR| scales with the prior's θ-margin
  return normalCDF(schoenfeldZ(hrTheta, t.eventsResolved!, zA));
}

// ─── Comparator distribution grid ────────────────────────────────────────────
//
// Represents the historical control / SOC rate as a probability DISTRIBUTION
// rather than a single known number. The width of this distribution depends on
// how well-established the benchmark is:
//   RCT (concurrent control) → comparatorSigma2 = 0, no comparator curve shown
//   Single-arm vs well-studied SOC → comparatorSigma2 ≈ 0.002-0.008 (narrow)
//   Single-arm vs approximate/sparse historical control → ≈ 0.010-0.040 (wide)
//
// The comparator curve is displayed alongside the drug prior/posterior so users
// can SEE that success = the drug's curve sitting clearly above the comparator's
// curve — accounting for both distributions' widths, not just a point threshold.

/**
 * Build a downsampled comparator density curve for UI display.
 * Converts (nullRR, comparatorSigma2) → Beta distribution → 60-point grid.
 * Returns null when comparatorSigma2 is negligibly small (no meaningful width).
 */
export function makeComparatorGrid(
  nullRR: number,
  comparatorSigma2: number,
): { theta: number[]; density: number[] } | null {
  if (comparatorSigma2 <= 0.0005) return null;
  // Build the comparator Beta DIRECTLY from its stated mean and variance (mean_rr = nullRR,
  // var_rr = comparatorSigma2). This used to round-trip through gaussianToBeta by INVERTING the
  // drug-side μ map — the bidirectional coupling that made the 2.2 scale fix hazardous. With
  // betaFromMeanVar there is no inverse: the comparator never enters μ-space at all.
  const { alpha, beta: betaP } = betaFromMeanVar(nullRR, comparatorSigma2);
  const grid = betaToGrid([{ w: 1, alpha, beta: betaP }]);
  return downsampleGrid(grid, 60);
}

// ─── Stage success probability (numerical integration) ───────────────────
//
// P(stage success) = ∫₀¹ P(success | θ, design) × prior(θ) dθ
//
// We compute this by summing over our 1001-point grid. This is exact
// enough (0.1% resolution on θ) and fast (<1ms).

/**
 * Compute P(trial success) by integrating the trial power function
 * against the prior density over θ.
 */
export function computeStageSuccess(
  priorGrid: RRGrid,
  n: number,
  nullRR: number,
  design: RRTrialDesign,
  comparatorSigma2: number = 0,
): number {
  let pSuccess = 0;
  for (let i = 0; i < priorGrid.theta.length; i++) {
    const power = rrTrialPower(priorGrid.theta[i], nullRR, n, design, comparatorSigma2);
    pSuccess += priorGrid.density[i] * power * GRID_STEP;
  }
  return Math.max(0, Math.min(1, pSuccess));
}

// ─── Bayesian posterior updating ─────────────────────────────────────────
//
// THIS IS THE CORE — the replacement for the heuristic.
//
// posterior(θ) ∝ prior(θ) × likelihood(data | θ)
//
// Two modes:
//   A. SUCCESS-EVENT: likelihood = P(trial succeeds | θ)
//      Used for future/projected trials.
//   B. OBSERVED-RESULT: likelihood = Binomial(k | n, θ)
//      Used when an actual response rate is known.

/**
 * SUCCESS-EVENT MODE: compute the posterior after observing that a
 * trial succeeded (without knowing the exact result).
 *
 * posterior(θ) ∝ prior(θ) × P(success | θ, design)
 *
 * This is the default for future/hypothetical trial stages.
 */
export function posteriorAfterSuccess(
  priorGrid: RRGrid,
  n: number,
  nullRR: number,
  design: RRTrialDesign,
  comparatorSigma2: number = 0,
): RRGrid {
  const theta = priorGrid.theta;
  const posterior: number[] = new Array(theta.length);

  for (let i = 0; i < theta.length; i++) {
    // capSingleArmToRct=false: the effect-estimate update uses the trial's actual
    // single-arm precision (Fix C's cap is a P(success) conclusiveness adjustment,
    // not a change to how much the drug's measured effect tightens).
    const power = rrTrialPower(theta[i], nullRR, n, design, comparatorSigma2, false);
    posterior[i] = priorGrid.density[i] * power;
  }

  // Normalize
  const total = posterior.reduce((s, d) => s + d, 0) * GRID_STEP;
  if (total > 1e-15) {
    const scale = 1 / total;
    for (let i = 0; i < theta.length; i++) posterior[i] *= scale;
  }

  return { theta: [...theta], density: posterior };
}

/**
 * OBSERVED-RESULT MODE: compute the posterior after observing a specific
 * response rate from a completed trial.
 *
 * posterior(θ) ∝ prior(θ) × Binomial(k; n, θ)
 *
 * where k = round(observedRR × n) is the number of responders.
 *
 * This updates the curve far more precisely than success-event mode
 * because we know the EXACT result, not just pass/fail.
 */
export function posteriorFromObservedRR(
  priorGrid: RRGrid,
  observedRR: number,
  observedN: number,
): RRGrid {
  const theta = priorGrid.theta;
  const k = Math.round(observedRR * observedN);
  const posterior: number[] = new Array(theta.length);

  // Use log-space to avoid underflow with large n
  for (let i = 0; i < theta.length; i++) {
    const t = theta[i];
    // log-likelihood: k×ln(θ) + (n-k)×ln(1-θ)
    // (we drop the constant lnChoose(n,k) since it cancels in normalization)
    const logLik = k * Math.log(t) + (observedN - k) * Math.log(1 - t);
    const logPosterior = Math.log(Math.max(priorGrid.density[i], 1e-300)) + logLik;
    posterior[i] = Math.exp(logPosterior);
  }

  // Normalize
  const total = posterior.reduce((s, d) => s + d, 0) * GRID_STEP;
  if (total > 1e-15) {
    const scale = 1 / total;
    for (let i = 0; i < theta.length; i++) posterior[i] *= scale;
  }

  return { theta: [...theta], density: posterior };
}

// ─── Band masses ─────────────────────────────────────────────────────────
//
// Divide the response-rate axis into three bands for plain-language
// explanation:
//   below threshold:  θ < nullRR                  ("drug doesn't work well enough")
//   modest:           nullRR ≤ θ < nullRR + Δ     ("clears the bar by less than an average drug")
//   strong:           θ ≥ nullRR + Δ              ("clears it by more than the average-evidence margin")
// where Δ = AVERAGE_EVIDENCE_DELTA_RR. The cutoff used to be a hard +0.20 — an artifact of the old
// absolute μ/2 scale, where margins ran 10–40 points; on the comparator-anchored scale (margins of
// 0–20 points, average = 0.10) a +0.20 "strong" band would be reachable only at the μ ceiling.

/**
 * Compute probability mass in each of three response-rate bands.
 */
export function computeBandMasses(grid: RRGrid, nullRR: number): RRBands {
  let below = 0, modest = 0, strong = 0;
  const modestCutoff = nullRR + AVERAGE_EVIDENCE_DELTA_RR;

  for (let i = 0; i < grid.theta.length; i++) {
    const mass = grid.density[i] * GRID_STEP;
    if (grid.theta[i] < nullRR) {
      below += mass;
    } else if (grid.theta[i] < modestCutoff) {
      modest += mass;
    } else {
      strong += mass;
    }
  }

  // Normalize to ensure they sum to 1 (compensate for grid boundary effects)
  const total = below + modest + strong;
  if (total > 1e-10) {
    below /= total;
    modest /= total;
    strong /= total;
  }

  return { belowThreshold: below, modest, strong };
}

// ─── Counterfactual helper ───────────────────────────────────────────────
//
// Re-run computeStageSuccess with one design parameter changed.
// Used for "what-if" ablations, NOT additive deltas.

/**
 * Compute P(success) under an alternative design, keeping the same prior.
 * Each counterfactual is a full re-run — captures non-linear interactions.
 */
export function computeCounterfactual(
  priorGrid: RRGrid,
  n: number,
  nullRR: number,
  design: RRTrialDesign,
  comparatorSigma2: number = 0,
): number {
  return computeStageSuccess(priorGrid, n, nullRR, design, comparatorSigma2);
}

// A single-arm registration trial leans on an EXTERNAL/historical control, which
// carries real benchmark uncertainty an in-trial RCT control does not. Floor the
// comparator variance for a single-arm what-if so "single-arm instead of RCT"
// correctly LOWERS credibility instead of gaming a concurrent control's zero
// variance (which made it spuriously beat the RCT). Display ablation only — this
// does NOT feed P(approval).
const SINGLE_ARM_CF_SIGMA2_FLOOR = 0.02;

/**
 * Generate standard counterfactual ablations for a stage.
 * Returns an array of { label, pSuccess } pairs.
 */
export function generateCounterfactuals(
  priorGrid: RRGrid,
  n: number,
  nullRR: number,
  design: RRTrialDesign,
  basePSuccess: number,
  comparatorSigma2: number = 0,
  gaussianMixture?: EffectPriorMixture,  // Build 2: biomarker what-if shifts the PRIOR (needs the mixture)
  anchorNull: number = nullRR,           // the evidence-context anchor the stage's prior was built on
): { label: string; pSuccess: number }[] {
  const results: { label: string; pSuccess: number }[] = [];

  // 1. What if the design type were different?
  if (design.designType === "rct") {
    // Swapping to single-arm forfeits the concurrent control → historical-benchmark
    // uncertainty applies (floored), so this correctly reads as LOWER, not higher.
    const saSigma2 = Math.max(comparatorSigma2, SINGLE_ARM_CF_SIGMA2_FLOOR);
    const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, designType: "single_arm" }, saSigma2);
    results.push({ label: "If single-arm instead of RCT", pSuccess: alt });
  } else {
    // Swapping to RCT gains a concurrent control → no external-benchmark uncertainty.
    const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, designType: "rct" }, 0);
    results.push({ label: "If RCT instead of single-arm", pSuccess: alt });
  }

  // 2. What if n were halved? (carry the same comparator uncertainty as the base)
  const halfN = computeCounterfactual(priorGrid, Math.round(n / 2), nullRR, design, comparatorSigma2);
  results.push({ label: `If n were halved (n=${Math.round(n / 2)})`, pSuccess: halfN });

  // 3. What if null RR were higher (harder bar)?
  //    Cap at 0.95 (near grid max), NOT 0.80 — a 0.80 cap made the "harder bar"
  //    LOWER than the base threshold once base > 0.70, inverting the counterfactual
  //    ("harder bar → higher success"). +0.10 above the (guarded) base is always
  //    genuinely harder → success can only move down.
  const harderNull = Math.min(0.95, nullRR + 0.10);
  const alt3 = computeCounterfactual(priorGrid, n, harderNull, design);
  results.push({ label: `If null RR were ${(harderNull * 100).toFixed(0)}% (harder bar)`, pSuccess: alt3 });

  // 4. What if the population were biomarker-enriched? (Build 2)
  // Enrichment shifts the effect PRIOR upstream (μ↑ / σ² tighter) — the same
  // mechanism the per-option recompute uses (effect-prior.ts enrichEffectPrior) — so
  // the two paths agree at stage level. The integral over the shifted prior computes
  // the higher P; the design's populationType is NOT flipped (no POP_N_FACTOR double-
  // count). Only when the base is not already biomarker-selected and we have the
  // mixture to shift; otherwise fall back to the (pre-Build-2) effective-n view.
  if (design.populationType !== "biomarker_selected") {
    if (gaussianMixture) {
      // Anchor on the SAME evidence context the stage's own prior was built on (anchorNull, not the
      // threshold), so the enriched prior and the base prior live on the same anchored scale.
      const enrichedGrid = betaToGrid(mixtureToBeta(enrichEffectPrior(gaussianMixture, DEFAULT_ENRICHMENT_LIFT), anchorNull));
      const alt = computeStageSuccess(enrichedGrid, n, nullRR, design, comparatorSigma2);
      results.push({ label: "If biomarker-selected population", pSuccess: alt });
    } else {
      const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, populationType: "biomarker_selected" });
      results.push({ label: "If biomarker-selected population", pSuccess: alt });
    }
  } else {
    const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, populationType: "broad" });
    results.push({ label: "If broad population (not biomarker-selected)", pSuccess: alt });
  }

  // Only include counterfactuals that meaningfully differ from base
  return results.filter((r) => Math.abs(r.pSuccess - basePSuccess) > 0.005);
}

// ─── Convenience: full pipeline for one stage ────────────────────────────

export type StageRRResult = {
  priorGrid: RRGrid;
  posteriorGrid: RRGrid;
  trialSuccessProb: number;
  bandsBefore: RRBands;
  bandsAfter: RRBands;
  priorMean: number;
  posteriorMean: number;
  effectiveNullRR: number;       // the threshold actually used (after floor + reliability guard)
  rawNullRR: number;             // the raw SOC rate before floor
  comparatorUnreliable: boolean; // raw threshold exceeded the drug's own prior mean →
                                 //   comparator discarded, held to clinical floor (fix #3 pins it)
  comparatorSigma2: number;      // variance of the historical control estimate
  /** Downsampled comparator density for chart display. null when comparatorSigma2 ≈ 0. */
  comparatorGrid: { theta: number[]; density: number[] } | null;
  counterfactuals: { label: string; pSuccess: number }[];
  // ── Layer 1 Phase 2 OUTPUTS (surfaced, NOT wired into cost/eNPV this pass). ──
  sequentialDesign?: {
    zBoundaries: number[];
    expectedInfoFraction: number; // E[information] as a fraction of max, at the prior-mean effect
    expectedN: number; // expectedInfoFraction × n (an OUTPUT metric; does not feed dev cost)
    futilityZBoundaries?: number[]; // β-spending lower boundaries (present only with futility)
    futilityBinding?: boolean; // true → efficacy re-solved so type-I held at α
    achievedTypeI?: number; // binding: the VERIFIED H0 type-I after the fixed-point (should ≈ α)
  };
  bayesianDesign?: {
    kStar: number;
    emergentAlpha: number; // frequentist type-I of the posterior rule at θ = refTheta (transparency)
    analysisPriorSourced: boolean; // false → reference Beta(1,1) default was used (flagged)
  };
  designFlags?: string[]; // resolve-or-flag notes (PP-deferred, bayesian-inert-on-non-proportion, …)
};

/**
 * Run the full Bayesian response-rate computation for one trial stage.
 *
 * @param gaussianMixture   Current effect-prior mixture (Gaussian space)
 * @param n                 Trial sample size
 * @param nullRR            Raw null/control response rate (0-1) — will be floored
 * @param design            Trial design parameters
 * @param isTimeToEvent     True if endpoint is TTE (higher threshold floor)
 * @param observedRR        If set, use observed-result mode instead of success-event
 * @param observedN         N for the observed result (required if observedRR set)
 * @param comparatorSigma2  Variance of the historical control estimate (0 for RCTs;
 *                          >0 for single-arm vs uncertain historical benchmark)
 */
export function computeStageRR(
  gaussianMixture: EffectPriorMixture,
  n: number,
  nullRR: number,
  design: RRTrialDesign,
  isTimeToEvent: boolean = false,
  observedRR?: number,
  observedN?: number,
  comparatorSigma2: number = 0,
  anchorNullRR?: number,
): StageRRResult {
  // 0. ANCHOR vs THRESHOLD — two different quantities, deliberately (the 2.2 semantics):
  //
  //    • The ANCHOR is the evidence context: the BASELINE comparator the effect prior's margin is
  //      scored against. It is endpoint-agnostic (proportion floor only) and NEVER moves with
  //      bar-raising adjustments. Callers that raise a stage's bar (active-comparator override, a
  //      corrected control rate) pass the ORIGINAL baseline as `anchorNullRR`.
  //    • The THRESHOLD (effectiveNull) is what THIS trial must actually beat: the (possibly raised)
  //      nullRR, floored by the endpoint family (the TTE proxy floor is higher).
  //
  //    Anchoring the prior on the threshold itself would neutralize every harder-bar mechanism —
  //    raise the bar and the prior follows it up, margin preserved, P unchanged. Separated, the prior
  //    stays where the evidence put it and a raised threshold moves up THROUGH it: active comparator
  //    lowers P, the TTE floor penalizes proxy stages, exactly as before the rescale. Both are
  //    input-only quantities — no circularity with the prior moments.
  //    The anchor and the threshold share the SAME endpoint-family floor: for a TTE-proxy stage the
  //    higher proxy floor RELOCATES the whole comparison (anchor and bar move together — the honest
  //    proxy penalties are the translation-failure component and comparator uncertainty, not a hidden
  //    margin handicap). If the anchor kept the lower proportion floor while the threshold took the
  //    TTE floor, every TTE-proxy stage would carry a fixed ~15-point margin deficit that no μ < 1.5
  //    could clear — that is exactly what collapsed TTX to pApproval 0.0004 mid-refactor. Anchor and
  //    threshold therefore diverge ONLY when a caller explicitly raises the bar via `anchorNullRR`.
  const floor = isTimeToEvent ? TTE_PROXY_RR_FLOOR : MEANINGFUL_RR_FLOOR;
  const anchorNull = Math.max(anchorNullRR ?? nullRR, floor);
  const flooredNull = Math.max(nullRR, floor);
  const effectiveNull = flooredNull;

  // 1. Convert to Beta mixture (anchored on the evidence context — see gaussianToBeta) and discretize
  const betaMix = mixtureToBeta(gaussianMixture, anchorNull);
  const priorGrid = betaToGrid(betaMix);
  const priorMoments = gridMoments(priorGrid);

  // §1.6 REMOVED VISIBLY — the comparatorUnreliable guard. It discarded the comparator (dropping the
  // threshold to the floor + flagging) when flooredNull > priorMean, which could only happen under the
  // OLD absolute map (mean_rr = μ/2), where a high sourced null could sit above the drug's asserted
  // absolute response. Under the comparator-anchored map, priorMean = flooredNull + μ·Δ ≥ flooredNull
  // for all μ ≥ 0, so the guard's condition is UNREACHABLE by construction: a prior can no longer be
  // forced entirely below its own threshold by a scale mismatch, because there is no second scale.
  // The result field stays (consumers read it) and is now always false.
  const comparatorUnreliable = false;

  // G2 Phase 2a: CONTINUOUS-family boundary calibration, computed ONCE here (needs the prior
  // mean + effectiveNull). dScale anchors d = expectedDelta/outcomeSd at the prior mean and
  // scales linearly with (θ − effectiveNull). Only when BOTH sourced stats are present and
  // valid; otherwise `powerDesign === design` → the exact proportion path (byte-identical).
  // Effect stays in the prior; SD is precision only. See continuousStagePower.
  let powerDesign: RRTrialDesign = design;
  if (design.continuous && design.continuous.outcomeSd > 0 && design.continuous.expectedDelta > 0) {
    powerDesign = {
      ...design,
      continuous: {
        ...design.continuous,
        dScale:
          (design.continuous.expectedDelta / design.continuous.outcomeSd) /
          Math.max(priorMoments.mean - effectiveNull, CONTINUOUS_MIN_MARGIN),
      },
    };
  } else if (
    // Layer 1 NATIVE-TTE resolution (RCT only this pass). Resolve events (explicit count or the
    // accrual sub-model) and the hrScale anchor ONCE here (needs priorMean + effectiveNull), mirroring
    // the 2a dScale — precision/anchor only, effect stays in the prior. hrScale is what GATES the native
    // path in rrTrialPower. Single-arm/basket TTE is not resolved (no validated one-sample log-rank this
    // pass) → it stays on the RR-proxy, byte-identical. Do NOT re-apply SURROGATE_TRANSLATION_SIGMA2:
    // a native-TTE stage reads its already-widened incoming prior.
    design.tte &&
    design.designType === "rct" &&
    design.tte.expectedHR > 0 &&
    design.tte.expectedHR !== 1
  ) {
    const events =
      design.tte.events != null && design.tte.events > 0
        ? design.tte.events
        : design.tte.accrual
        ? tteEventsFromAccrual(design.tte.accrual, design.tte.expectedHR, 0.5)
        : NaN;
    if (Number.isFinite(events) && events > 0) {
      powerDesign = {
        ...design,
        tte: {
          ...design.tte,
          eventsResolved: events,
          hrScale:
            Math.abs(Math.log(design.tte.expectedHR)) /
            Math.max(priorMoments.mean - effectiveNull, CONTINUOUS_MIN_MARGIN),
        },
      };
    }
  }

  // ── Layer 1 Phase 2 resolution (θ-independent markers; mirrors dScale/hrScale). Absent spec →
  //    no markers set → the exact single-look path in rrTrialPower (FROZEN byte-identical). ──
  const designFlags: string[] = [];
  let sequentialDesign: StageRRResult["sequentialDesign"];
  let bayesianDesign: StageRRResult["bayesianDesign"];

  const seqLooks = design.sequential?.lookFractions;
  const wantSeq = Array.isArray(seqLooks) && seqLooks.length >= 1;
  const endpointIsProportion = !design.continuous && !design.tte;
  const wantBayes = design.bayesian != null && design.bayesian.postThreshold != null;

  if (wantSeq && wantBayes) {
    // sequential + Bayesian = predictive-probability = DEFERRED. Resolve NEITHER marker → base
    // single-look path. Flag it; never a fabricated combination.
    designFlags.push("sequential+bayesian (predictive-probability) deferred — using base single-look power");
  } else if (wantSeq) {
    const spending: SpendingFunction = design.sequential!.spending === "POCOCK" ? "POCOCK" : "OBF";
    if (design.sequential!.spending === "LDL") designFlags.push("LDL spending not implemented this pass — using OBF");
    // design.alpha (or the inverted category) is the TOTAL α; the spending function distributes it
    // across looks and the boundaries REPLACE the single-look z_α.
    const alphaTotal =
      design.alpha?.value != null && Number.isFinite(design.alpha.value)
        ? design.alpha.value
        : 1 - normalCDF(Z_ALPHA[design.regulatoryContext] ?? 1.645);

    // Design-alternative drift ξ_design = READOUT of the prior mean (base, non-sequential power) —
    // needed for β-spending futility. Single-locus: the effect stays in the prior; this only reads it.
    const baseAtMean = rrTrialPower(priorMoments.mean, effectiveNull, n, { ...powerDesign, sequential: undefined, bayesian: undefined }, comparatorSigma2);
    const bpm = Math.min(1 - 1e-12, Math.max(1e-12, baseAtMean));
    const driftDesign = Math.min(20, Math.max(-20, normalInv(bpm) + computeZAlpha(design)));

    const fut = design.sequential!.futility;
    const useBeta = fut != null && fut.futilityType === "beta-spending" && driftDesign > 0.5;
    let effZ: number[];
    let futZ: number[] | undefined;
    let futMeta: { futilityZBoundaries: number[]; futilityBinding: boolean; achievedTypeI: number } | undefined;
    if (useBeta) {
      const r = resolveFutilityDesign(
        alphaTotal, seqLooks!, spending,
        { binding: !!fut!.binding, beta: fut!.beta ?? 0.1, spending: fut!.spending === "POCOCK" ? "POCOCK" : "OBF" },
        driftDesign,
      );
      effZ = r.effZ;
      futZ = r.futZ;
      futMeta = { futilityZBoundaries: r.futZ, futilityBinding: r.binding, achievedTypeI: r.achievedAlpha };
      // Binding correctness gate (soft, observe-don't-halt): the re-solve must hold type-I at α.
      if (r.binding && Math.abs(r.achievedAlpha - alphaTotal) > 1e-3) {
        designFlags.push(`binding futility: type-I ${r.achievedAlpha.toFixed(5)} ≠ α ${alphaTotal.toFixed(5)} (solve did not converge)`);
      }
    } else {
      if (fut && fut.futilityType === "conditional-power") designFlags.push("conditional-power futility deferred (fast-follow) — using efficacy-only");
      else if (fut && fut.futilityType === "beta-spending") designFlags.push("β-spending futility not resolved: design drift at the prior mean too weak — efficacy-only");
      effZ = sequentialBoundaries(alphaTotal, seqLooks!, spending).zBoundaries; // efficacy-only (byte-identical)
    }

    // drift→P(cross) table WITH futility baked in (futZ undefined → efficacy-only, byte-identical).
    const driftGrid: number[] = [];
    const pGrid: number[] = [];
    for (let d = -3; d <= 8.0001; d += 0.1) {
      driftGrid.push(d);
      pGrid.push(pCrossGivenBoundaries(effZ, seqLooks!, d, futZ));
    }
    powerDesign = {
      ...powerDesign,
      sequential: { ...design.sequential!, zBoundaries: effZ, pCrossTable: { drift: driftGrid, p: pGrid } },
    };
    // E[N] at the prior-mean effect (OUTPUT only; NOT wired into cost), with futility if present.
    const eInfoFrac = expectedInfoFractionGivenBoundaries(effZ, seqLooks!, driftDesign, futZ);
    sequentialDesign = { zBoundaries: effZ, expectedInfoFraction: eInfoFrac, expectedN: eInfoFrac * n, ...(futMeta ?? {}) };
  } else if (wantBayes && endpointIsProportion) {
    const prior = design.bayesian!.analysisPrior ?? { a: 1, b: 1 };
    const priorSourced = design.bayesian!.analysisPrior != null;
    if (!priorSourced) designFlags.push("Bayesian analysis prior unspecified — using reference Beta(1,1), not sourced");
    const refT = design.bayesian!.refTheta ?? effectiveNull;
    const kStar = bayesianCritK(n, refT, design.bayesian!.postThreshold!, prior);
    powerDesign = { ...powerDesign, bayesian: { ...design.bayesian!, kStar } };
    bayesianDesign = { kStar, emergentAlpha: bayesianThresholdPower(refT, n, kStar), analysisPriorSourced: priorSourced };
  } else if (wantBayes && !endpointIsProportion) {
    designFlags.push("Bayesian posterior-threshold applies to the proportion family only — inert on continuous/TTE this pass; using base power");
  }

  // 2. Compute P(stage success) via numerical integration (with comparator uncertainty)
  const trialSuccessProb = computeStageSuccess(priorGrid, n, effectiveNull, powerDesign, comparatorSigma2);

  // 3. Compute posterior
  const posteriorGrid = (observedRR != null && observedN != null)
    ? posteriorFromObservedRR(priorGrid, observedRR, observedN)
    : posteriorAfterSuccess(priorGrid, n, effectiveNull, powerDesign, comparatorSigma2);

  // 4. Band masses before and after (use effective threshold for bands)
  const bandsBefore = computeBandMasses(priorGrid, effectiveNull);
  const bandsAfter = computeBandMasses(posteriorGrid, effectiveNull);

  // 5. Summary statistics
  const posteriorMoments = gridMoments(posteriorGrid);

  // 6. Counterfactual ablations (power against the effective threshold; priors on the anchor)
  const counterfactuals = generateCounterfactuals(
    priorGrid, n, effectiveNull, powerDesign, trialSuccessProb, comparatorSigma2, gaussianMixture, anchorNull,
  );

  // 7. Build comparator distribution curve for display
  const comparatorGrid = makeComparatorGrid(effectiveNull, comparatorSigma2);

  return {
    priorGrid,
    posteriorGrid,
    trialSuccessProb,
    bandsBefore,
    bandsAfter,
    priorMean: priorMoments.mean,
    posteriorMean: posteriorMoments.mean,
    effectiveNullRR: effectiveNull,
    rawNullRR: nullRR,
    comparatorUnreliable,
    comparatorSigma2,
    comparatorGrid,
    counterfactuals,
    sequentialDesign,
    bayesianDesign,
    designFlags: designFlags.length ? designFlags : undefined,
  };
}
