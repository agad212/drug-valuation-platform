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

import { normalCDF } from "./effect-prior";
import type { EffectPriorMixture } from "./effect-prior";
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
  modest: number;         // nullRR ≤ θ < nullRR + 0.20
  strong: number;         // θ ≥ nullRR + 0.20
};

/** Trial design parameters needed for the power calculation. */
export type RRTrialDesign = {
  designType: DesignType;
  endpointType: EndpointType;
  populationType: PopulationType;
  regulatoryContext: RegulatoryContext;
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

// Population type → effective sample size multiplier
// Biomarker-selected populations are cleaner (less noise), so the same n
// gives more statistical information. Rare/small populations are noisier.
const POP_N_FACTOR: Record<PopulationType, number> = {
  biomarker_selected: 1.3,
  broad: 1.0,
  rare_small: 0.8,
};

// Endpoint type → effective sample size multiplier
// Hard endpoints (OS, CR) are more reliably measured → cleaner signal.
// PRO/subjective endpoints have investigator bias → noisier.
const ENDPOINT_N_FACTOR: Record<EndpointType, number> = {
  hard: 1.2,
  surrogate: 1.0,
  pro: 0.7,
};

// Regulatory context → one-sided significance level z-value
// BTD/orphan programs get regulatory flexibility (lower bar).
// Confirmatory trials face a stricter bar.
const Z_ALPHA: Record<RegulatoryContext, number> = {
  btd: 1.28,           // α ≈ 0.10 one-sided
  orphan: 1.28,
  btd_orphan: 1.28,
  accelerated: 1.28,
  standard: 1.645,     // α = 0.05 one-sided
  confirmatory: 1.96,  // α = 0.025 one-sided
};

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
// The evidence integration engine (effect-prior.ts) works in Gaussian
// space with mu ∈ [0, 2] and sigma2 ∈ [0.05, 0.8]. We convert to
// Beta space at the boundary: mean_rr = mu/2, var_rr = sigma2/4.
//
// WHY mu/2? Because the Gaussian "mu" is defined as ≈ mss × 2 where
// mss ∈ [0, 1] is the mechanism signal strength, which maps directly
// to response rate (mss ≈ expected RR).

/**
 * Convert a single Gaussian component (mu, sigma2) from the effect-prior
 * engine into Beta parameters (alpha, beta) on [0, 1].
 *
 * Mapping:
 *   mean_rr = mu / 2          (Gaussian mu ∈ [0,2] → RR ∈ [0,1])
 *   var_rr  = sigma2 / 4      (scale variance accordingly)
 *   concentration = mean(1-mean)/var_rr - 1   (how peaked the Beta is)
 *   alpha = mean × concentration
 *   beta  = (1-mean) × concentration
 */
export function gaussianToBeta(mu: number, sigma2: number): { alpha: number; beta: number } {
  const mean = Math.max(0.01, Math.min(0.99, mu / 2));
  const varRR = Math.max(1e-6, sigma2 / 4);

  // concentration = mean(1-mean)/variance - 1
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
 * Convert a full Gaussian mixture (from effect-prior.ts) to a Beta mixture.
 * Each component is converted independently; weights are preserved.
 */
export function mixtureToBeta(mixture: EffectPriorMixture): BetaMixture {
  return mixture.map((c) => {
    const { alpha, beta } = gaussianToBeta(c.mu, c.sigma2);
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
): EffectPriorMixture {
  if (nComponents <= 1 || grid.theta.length === 0) {
    const { mean, variance } = gridMoments(grid);
    return [{
      w: 1,
      mu: mean * 2,     // back to Gaussian mu ∈ [0, 2]
      sigma2: Math.max(1e-6, variance * 4),  // back to Gaussian variance scale
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
      mu: mean * 2,
      sigma2: variance * 4,
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
 * @param theta    True response rate (0-1)
 * @param nullRR   Null/control response rate (historical control or SOC)
 * @param n        Total sample size
 * @param design   Trial design parameters affecting n_effective and z_alpha
 */
export function rrTrialPower(
  theta: number,
  nullRR: number,
  n: number,
  design: RRTrialDesign,
): number {
  if (theta <= 0 || theta >= 1) return theta >= 1 ? 1 : 0;
  if (n < 1) return 0;

  const nEff = n
    * (POP_N_FACTOR[design.populationType] ?? 1.0)
    * (ENDPOINT_N_FACTOR[design.endpointType] ?? 1.0);

  const zA = Z_ALPHA[design.regulatoryContext] ?? 1.645;

  if (design.designType === "rct") {
    // Two-proportion z-test power (equal allocation)
    const nArm = Math.max(1, nEff / 2);
    const se = Math.sqrt(
      (theta * (1 - theta) + nullRR * (1 - nullRR)) / nArm
    );
    if (se < 1e-10) return theta > nullRR ? 1 : 0;
    return normalCDF((theta - nullRR) / se - zA);
  }

  // Single-arm (or basket): one-proportion test vs historical control
  const nSingleArm = design.designType === "basket"
    ? Math.max(1, nEff / 3)  // basket splits across ~3 cohorts
    : Math.max(1, nEff);

  // Critical observed RR to reject H₀
  const seCrit = Math.sqrt(nullRR * (1 - nullRR) / nSingleArm);
  const thetaCrit = nullRR + zA * seCrit;

  // Power: P(observed RR > θ_crit | θ_true)
  const seObs = Math.sqrt(theta * (1 - theta) / nSingleArm);
  if (seObs < 1e-10) return theta > thetaCrit ? 1 : 0;
  return normalCDF((theta - thetaCrit) / seObs);
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
): number {
  let pSuccess = 0;
  for (let i = 0; i < priorGrid.theta.length; i++) {
    const power = rrTrialPower(priorGrid.theta[i], nullRR, n, design);
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
): RRGrid {
  const theta = priorGrid.theta;
  const posterior: number[] = new Array(theta.length);

  for (let i = 0; i < theta.length; i++) {
    const power = rrTrialPower(theta[i], nullRR, n, design);
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
//   below threshold:  θ < nullRR           ("drug doesn't work well enough")
//   modest:           nullRR ≤ θ < nullRR + 0.20  ("works, modestly")
//   strong:           θ ≥ nullRR + 0.20    ("strong responder")

/**
 * Compute probability mass in each of three response-rate bands.
 */
export function computeBandMasses(grid: RRGrid, nullRR: number): RRBands {
  let below = 0, modest = 0, strong = 0;
  const modestCutoff = nullRR + 0.20;

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
): number {
  return computeStageSuccess(priorGrid, n, nullRR, design);
}

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
): { label: string; pSuccess: number }[] {
  const results: { label: string; pSuccess: number }[] = [];

  // 1. What if the design type were different?
  if (design.designType === "rct") {
    const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, designType: "single_arm" });
    results.push({ label: "If single-arm instead of RCT", pSuccess: alt });
  } else {
    const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, designType: "rct" });
    results.push({ label: "If RCT instead of single-arm", pSuccess: alt });
  }

  // 2. What if n were halved?
  const halfN = computeCounterfactual(priorGrid, Math.round(n / 2), nullRR, design);
  results.push({ label: `If n were halved (n=${Math.round(n / 2)})`, pSuccess: halfN });

  // 3. What if null RR were higher (harder bar)?
  const harderNull = Math.min(0.80, nullRR + 0.10);
  const alt3 = computeCounterfactual(priorGrid, n, harderNull, design);
  results.push({ label: `If null RR were ${(harderNull * 100).toFixed(0)}% (harder bar)`, pSuccess: alt3 });

  // 4. What if population were different?
  if (design.populationType === "biomarker_selected") {
    const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, populationType: "broad" });
    results.push({ label: "If broad population (not biomarker-selected)", pSuccess: alt });
  } else if (design.populationType === "broad") {
    const alt = computeCounterfactual(priorGrid, n, nullRR, { ...design, populationType: "biomarker_selected" });
    results.push({ label: "If biomarker-selected population", pSuccess: alt });
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
  effectiveNullRR: number;       // the threshold actually used (after floor)
  rawNullRR: number;             // the raw SOC rate before floor
  counterfactuals: { label: string; pSuccess: number }[];
};

/**
 * Run the full Bayesian response-rate computation for one trial stage.
 *
 * @param gaussianMixture  Current effect-prior mixture (Gaussian space)
 * @param n                Trial sample size
 * @param nullRR           Raw null/control response rate (0-1) — will be floored
 * @param design           Trial design parameters
 * @param isTimeToEvent    True if endpoint is TTE (higher threshold floor)
 * @param observedRR       If set, use observed-result mode instead of success-event
 * @param observedN        N for the observed result (required if observedRR set)
 */
export function computeStageRR(
  gaussianMixture: EffectPriorMixture,
  n: number,
  nullRR: number,
  design: RRTrialDesign,
  isTimeToEvent: boolean = false,
  observedRR?: number,
  observedN?: number,
): StageRRResult {
  // 0. Apply clinically meaningful threshold floor
  const effectiveNull = effectiveThreshold(nullRR, isTimeToEvent);

  // 1. Convert to Beta mixture and discretize on grid
  const betaMix = mixtureToBeta(gaussianMixture);
  const priorGrid = betaToGrid(betaMix);

  // 2. Compute P(stage success) via numerical integration
  const trialSuccessProb = computeStageSuccess(priorGrid, n, effectiveNull, design);

  // 3. Compute posterior
  const posteriorGrid = (observedRR != null && observedN != null)
    ? posteriorFromObservedRR(priorGrid, observedRR, observedN)
    : posteriorAfterSuccess(priorGrid, n, effectiveNull, design);

  // 4. Band masses before and after (use effective threshold for bands)
  const bandsBefore = computeBandMasses(priorGrid, effectiveNull);
  const bandsAfter = computeBandMasses(posteriorGrid, effectiveNull);

  // 5. Summary statistics
  const priorMoments = gridMoments(priorGrid);
  const posteriorMoments = gridMoments(posteriorGrid);

  // 6. Counterfactual ablations (use effective threshold)
  const counterfactuals = generateCounterfactuals(
    priorGrid, n, effectiveNull, design, trialSuccessProb,
  );

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
    counterfactuals,
  };
}
