// ═══════════════════════════════════════════════════════════════════════════
// True Effect Prior — Evidence Integration Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Builds a running estimate of "how strong is this drug's true biological
// effect" by sequentially folding in evidence sources, in order:
//   1. mechanism / pharmacology   2. animal efficacy & safety data
//   3. same-target / analog clinical data   4. the drug's own clinical data
//
// The estimate is represented as a Gaussian MIXTURE — usually one "curve"
// (unimodal): "we think the effect is around here, give or take this much."
// But when evidence genuinely CONFLICTS, it can split into TWO curves
// (bimodal): "maybe this is the strong-effect world, maybe this is the
// weak-effect world" — a real coin-flip, each story weighted by how much we
// trust the evidence behind it. That split — and the weights — is the core
// proprietary output of this engine.
//
// UNITS — same scale as lib/ptrs-trial.ts, no new scale invented:
//   mu      ≈ mss × 2.0   (range roughly 0-2; success threshold ≈ 0.80)
//   sigma2  ≈ variance     (range roughly 0.05-0.8)
// The mechanism step is seeded directly from scoreMechanism()'s output
// (mu = mss * 2.0, sigma2 = variance), so mixtureSuccessProbability() below
// is a drop-in generalization of scoreLayer2's existing normalCDF(z) call —
// zero recalibration needed.
//
// This file is PURE MATH: no API calls, no React, no side effects. It is
// designed to be consumed by the development-plan probability chain
// (lib/dev-plan.ts) and, in a future step, by lib/decision-analysis.ts for
// "is this drug a coin-flip worth resolving before committing more money?"
//
// ═══════════════════════════════════════════════════════════════════════════

// ─── Types ────────────────────────────────────────────────────────────────

/** One "curve" in the mixture: its weight, center (mu), and spread (sigma2). */
export type GaussianComponent = {
  /** Mixture weight, 0-1. All weights in a mixture sum to 1. */
  w: number;
  /** Mean effect strength — same units as ptrs-trial.ts `mu` (≈ mss × 2.0, roughly 0-2). */
  mu: number;
  /** Variance — same units as ptrs-trial.ts `variance` (roughly 0.05-0.8). */
  sigma2: number;
};

/**
 * A probability distribution over "true drug effect strength."
 * 1 component = a single bell curve (the normal case).
 * 2 components = a "coin-flip" between two competing stories.
 * Weights across all components sum to 1.
 */
export type EffectPriorMixture = GaussianComponent[];

/** The four evidence sources, in the order they're normally folded in. */
export type EvidenceSourceType = "mechanism" | "animal" | "analog" | "own_clinical";

/** What one piece of evidence implies about effect strength, in the shared (mu, sigma2) units. */
export type EvidenceSignal = {
  mu: number;
  sigma2: number;
};

/**
 * One evidence-chain step as supplied by the caller (in a future step, this
 * comes from AI-driven evidence discovery + reasoning).
 *
 * The first step MUST be source "mechanism" with found=true and a `signal` —
 * it seeds the running mixture. Later steps may have found=false (e.g. "no
 * valid analogs found for this mechanism"), in which case `signal` is omitted
 * and the running mixture passes through unchanged.
 */
export type EvidenceStepInput = {
  source: EvidenceSourceType;
  /** Human-readable label, e.g. "Animal model: xenograft efficacy study". */
  label: string;
  found: boolean;
  /** Required iff found === true. */
  signal?: EvidenceSignal;
  /** Free-text explanation of where this signal came from and why — passed through unchanged. */
  reasoning: string;
};

/**
 * A record of one step in the evidence chain: the mixture immediately before
 * and after this step, whether the new evidence agreed or disagreed with what
 * came before, and the reasoning behind it. This is what a future step-by-step
 * UI renders as the plain-language "story."
 */
export type ChainStep = {
  source: EvidenceSourceType;
  label: string;
  found: boolean;
  signal?: EvidenceSignal;
  mixtureBefore: EffectPriorMixture;
  mixtureAfter: EffectPriorMixture;
  /** "n/a" only when found === false (nothing to agree or disagree with). */
  agreement: "agree" | "disagree" | "n/a";
  reasoning: string;
};

/** Final output of the evidence-integration chain. */
export type EffectPrior = {
  mixture: EffectPriorMixture;
  shape: "unimodal" | "bimodal";
  chain: ChainStep[];
};

// ─── Tunable constants ───────────────────────────────────────────────────────
// All "magic numbers" for the update rule live here, named and explained, so
// they're easy to find and recalibrate without hunting through the logic.

/**
 * Cutoff, in pooled-standard-deviation units, that separates "this new
 * evidence roughly AGREES with what we already believed" from "this new
 * evidence DISAGREES enough to split into two competing stories."
 *
 *   d = |mu_new - mu_existing| / sqrt(sigma2_new + sigma2_existing)
 *
 * 1.5 pooled SDs ≈ "the two sources' plausible ranges barely overlap" — a
 * deliberately generous bar, so ordinary noisy agreement (within about 1 SD)
 * merges normally, while genuinely conflicting evidence (e.g. mechanism says
 * "strong effect" but same-class drugs have a real track record of failing)
 * triggers a split into a bimodal mixture.
 *
 * This is a starting value, not yet calibrated against real drugs — expect to
 * tune it once this runs on real cases. Lower = splits more readily;
 * higher = requires starker disagreement before splitting.
 */
export const AGREEMENT_Z_THRESHOLD = 1.5;

/**
 * Minimum weight required on BOTH curves of a 2-component mixture for the
 * result to be reported as "bimodal" (a real coin-flip) rather than
 * "unimodal" (effectively one story with a footnote).
 *
 * A disagreement-driven split can produce a near-zero second weight (e.g. 2%)
 * when the new signal's precision is tiny relative to the running estimate —
 * that's not a meaningful "two competing stories" situation.
 */
export const BIMODAL_MIN_WEIGHT = 0.05;

/**
 * Floor applied to sigma2 before it's used as a divisor (precision = 1/sigma2,
 * or inside sqrt(sigma2_a + sigma2_b)). A pure defensive guard against
 * divide-by-zero/NaN if sigma2 = 0 is ever passed in — real evidence inputs
 * are expected to stay >= ~0.05 in practice (ptrs-mechanism-scorer.ts's
 * variance floors at 0.05).
 */
export const MIN_SIGMA2 = 1e-6;

// ─── Normal CDF (Abramowitz & Stegun approximation) ──────────────────────────
// KEEP IN SYNC with the equivalent private helper in lib/ptrs-trial.ts
// (also named normalCDF). Duplicated here because ptrs-trial.ts does not
// export it. Max error ~7.5e-8.

export function normalCDF(z: number): number {
  if (z < -6) return 0;
  if (z > 6) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? 1 - phi : phi;
}

// ─── Trial success probability under a mixture ──────────────────────────────
//
// Literal generalization of scoreLayer2's existing formula:
//   single curve:  P(success) = Φ((mu - threshold) / sqrt(sigma2 + sigma2Trial))
//   mixture:       P(success) = Σ wᵢ · Φ((muᵢ - threshold) / sqrt(sigma2ᵢ + sigma2Trial))
//
// When mixture = [{ w: 1, mu, sigma2 }], this reduces EXACTLY to the
// single-curve formula above (1 * Φ(z) = Φ(z)) — a drop-in replacement.

export function mixtureSuccessProbability(
  mixture: EffectPriorMixture,
  threshold: number,
  sigma2Trial: number
): number {
  let total = 0;
  for (const { w, mu, sigma2 } of mixture) {
    const z = (mu - threshold) / Math.sqrt(Math.max(sigma2, 0) + sigma2Trial);
    total += w * normalCDF(z);
  }
  return total;
}

// ─── Mixture <-> scalar (mss, variance) conversion ───────────────────────────
//
// Bridges to the pre-mixture world: every existing caller of scoreLayer2 /
// computeDevPlan worked with a single (mss, variance) pair. These two
// functions let mixture-aware code interoperate with that world without
// throwing away information.

/**
 * Wrap a single (mss, variance) pair as a 1-component mixture — the fallback
 * used before an EffectPrior is available, or by callers that don't have one.
 */
export function mixtureFromMssVariance(mss: number, variance: number): EffectPriorMixture {
  return [{ w: 1, mu: mss * 2, sigma2: Math.max(variance, MIN_SIGMA2) }];
}

/**
 * Collapse a mixture to a single (mss, variance) pair via the law of total
 * variance:
 *   muBar     = Σ wᵢ·μᵢ
 *   sigma2Bar = Σ wᵢ·σ²ᵢ  +  Σ wᵢ·(μᵢ - muBar)²
 *               within-curve    between-curve spread
 *
 * For a 1-component mixture this reduces exactly to {mss: mu/2, variance:
 * sigma2} — a no-op round trip with mixtureFromMssVariance. For a bimodal
 * mixture, the "between-curve" term correctly inflates the reported variance
 * to reflect the coin-flip itself, so existing scalar UI (σ² displays) widens
 * appropriately even before it's updated to show two curves directly.
 */
export function mixtureMoments(mixture: EffectPriorMixture): { mss: number; variance: number } {
  const muBar = mixture.reduce((sum, c) => sum + c.w * c.mu, 0);
  const within = mixture.reduce((sum, c) => sum + c.w * c.sigma2, 0);
  const between = mixture.reduce((sum, c) => sum + c.w * (c.mu - muBar) ** 2, 0);
  return { mss: muBar / 2, variance: within + between };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Pooled-SD distance between a new signal and an existing curve: |Δμ| / sqrt(σ²_new + σ²_existing). */
function zDistance(
  signal: { mu: number; sigma2: number },
  component: { mu: number; sigma2: number }
): number {
  const denom = Math.sqrt(
    Math.max(signal.sigma2, MIN_SIGMA2) + Math.max(component.sigma2, MIN_SIGMA2)
  );
  return Math.abs(signal.mu - component.mu) / denom;
}

/**
 * Standard precision-weighted Bayesian merge of two (mu, sigma2) pairs:
 *   τ = 1/σ²                     (precision)
 *   μ_post = (τ_a·μ_a + τ_b·μ_b) / (τ_a + τ_b)
 *   σ²_post = 1 / (τ_a + τ_b)
 * Also returns both precisions, since the disagreement branch below needs
 * them to compute a weight split.
 */
function precisionWeightedMerge(
  a: { mu: number; sigma2: number },
  b: { mu: number; sigma2: number }
): { mu: number; sigma2: number; tauA: number; tauB: number } {
  const tauA = 1 / Math.max(a.sigma2, MIN_SIGMA2);
  const tauB = 1 / Math.max(b.sigma2, MIN_SIGMA2);
  const tauPost = tauA + tauB;
  return {
    mu: (tauA * a.mu + tauB * b.mu) / tauPost,
    sigma2: 1 / tauPost,
    tauA,
    tauB,
  };
}

/** Deep-ish copy so a chain history snapshot can't be mutated by a later step. */
function cloneMixture(mixture: EffectPriorMixture): EffectPriorMixture {
  return mixture.map((c) => ({ ...c }));
}

// ─── Mixture update rule ─────────────────────────────────────────────────────

/**
 * Folds one new evidence signal into the running mixture.
 *
 * - **Running has 1 curve, signal AGREES** (d ≤ AGREEMENT_Z_THRESHOLD):
 *   standard precision-weighted merge → stays 1 curve, narrower than either
 *   input, centered closer to whichever input was more confident.
 *
 * - **Running has 1 curve, signal DISAGREES** (d > AGREEMENT_Z_THRESHOLD):
 *   splits into 2 curves — the existing curve (unchanged) and the new signal
 *   (unchanged), weighted by relative precision
 *   (w_new = τ_new / (τ_existing + τ_new)).
 *
 * - **Running already has 2 curves** (a coin-flip already exists):
 *   v1 simplification — see the long comment below. Always returns 1 or 2
 *   curves, never 3.
 */
export function updateMixture(
  running: EffectPriorMixture,
  signal: EvidenceSignal
): { mixture: EffectPriorMixture; agreement: "agree" | "disagree" } {
  if (running.length === 1) {
    const existing = running[0];
    const d = zDistance(signal, existing);

    if (d <= AGREEMENT_Z_THRESHOLD) {
      // Agreement: combine into one narrower curve.
      const merged = precisionWeightedMerge(existing, signal);
      return {
        mixture: [{ w: 1, mu: merged.mu, sigma2: merged.sigma2 }],
        agreement: "agree",
      };
    }

    // Disagreement: split into two curves — existing story vs. new story,
    // weighted by relative precision (more confident source gets more weight).
    const tauExisting = 1 / Math.max(existing.sigma2, MIN_SIGMA2);
    const tauNew = 1 / Math.max(signal.sigma2, MIN_SIGMA2);
    const wNew = tauNew / (tauExisting + tauNew);
    return {
      mixture: [
        { w: 1 - wNew, mu: existing.mu, sigma2: existing.sigma2 },
        { w: wNew, mu: signal.mu, sigma2: signal.sigma2 },
      ],
      agreement: "disagree",
    };
  }

  // ── v1 SIMPLIFICATION: the mixture has already split into two curves ──────
  // (a coin-flip already exists), and a further piece of evidence arrives.
  //
  // This v1 ALWAYS folds the new evidence into whichever of the two existing
  // curves it's closer to (same precision-weighted merge as the agree case
  // above), leaves the OTHER curve's (mu, sigma2) untouched, and FREEZES both
  // mixture weights at whatever they were when the split first occurred —
  // weights are never recomputed in response to later evidence.
  //
  // The principled version of this ("Bayesian model averaging") would treat
  // each curve as a competing hypothesis, compute how likely the new evidence
  // is under each one, and reweight both curves by that likelihood ratio.
  // That's real design work on its own and is deferred past v1. Freezing
  // weights is a safe, auditable default: the chain record still shows which
  // curve each later piece of evidence was folded into and whether it agreed
  // or disagreed, so a reviewer can sanity-check the story even though the
  // weights themselves don't evolve further. Given the chain is normally only
  // 4 steps, a *third* disagreement after the chain has already split is rare.
  const [a, b] = running;
  const dA = zDistance(signal, a);
  const dB = zDistance(signal, b);
  const agreement: "agree" | "disagree" =
    Math.min(dA, dB) <= AGREEMENT_Z_THRESHOLD ? "agree" : "disagree";

  const closerIsA = dA <= dB;
  const merged = precisionWeightedMerge(closerIsA ? a : b, signal);
  const updated: GaussianComponent = {
    w: closerIsA ? a.w : b.w,
    mu: merged.mu,
    sigma2: merged.sigma2,
  };
  const unchanged: GaussianComponent = closerIsA ? b : a;

  return {
    mixture: closerIsA ? [updated, unchanged] : [unchanged, updated],
    agreement,
  };
}

// ─── Evidence chain builder ───────────────────────────────────────────────────

/** "bimodal" only if there are exactly 2 curves AND both have weight ≥ BIMODAL_MIN_WEIGHT. */
function computeShape(mixture: EffectPriorMixture): "unimodal" | "bimodal" {
  if (mixture.length !== 2) return "unimodal";
  const [a, b] = mixture;
  return a.w >= BIMODAL_MIN_WEIGHT && b.w >= BIMODAL_MIN_WEIGHT ? "bimodal" : "unimodal";
}

/**
 * Walks the evidence steps in order, building up the running mixture and
 * recording each step's before/after state in the chain.
 *
 * Step 0 MUST be a found "mechanism" step with a signal — it seeds the
 * single starting curve. If it's missing or malformed, this throws rather
 * than guessing default numbers: every later step builds on this first
 * estimate, so an honest error here is better than a silently-wrong final
 * probability feeding into the rest of the development-plan chain.
 *
 * Later steps with found=false pass the mixture through unchanged
 * (agreement: "n/a") — e.g. "no valid analogs found for this mechanism".
 */
export function buildEffectPrior(steps: EvidenceStepInput[]): EffectPrior {
  if (steps.length === 0) {
    throw new Error("buildEffectPrior: steps must contain at least one step (the mechanism step).");
  }

  const first = steps[0];
  if (first.source !== "mechanism" || !first.found || !first.signal) {
    throw new Error(
      `buildEffectPrior: the first step must be a found "mechanism" step with a signal (got source="${first.source}", found=${first.found}).`
    );
  }

  let running: EffectPriorMixture = [{ w: 1, mu: first.signal.mu, sigma2: first.signal.sigma2 }];
  const chain: ChainStep[] = [
    {
      source: first.source,
      label: first.label,
      found: first.found,
      signal: first.signal,
      mixtureBefore: [],
      mixtureAfter: cloneMixture(running),
      agreement: "n/a",
      reasoning: first.reasoning,
    },
  ];

  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    const mixtureBefore = cloneMixture(running);

    if (!step.found || !step.signal) {
      chain.push({
        source: step.source,
        label: step.label,
        found: step.found,
        signal: step.signal,
        mixtureBefore,
        mixtureAfter: cloneMixture(running),
        agreement: "n/a",
        reasoning: step.reasoning,
      });
      continue;
    }

    const { mixture, agreement } = updateMixture(running, step.signal);
    running = mixture;
    chain.push({
      source: step.source,
      label: step.label,
      found: step.found,
      signal: step.signal,
      mixtureBefore,
      mixtureAfter: cloneMixture(running),
      agreement,
      reasoning: step.reasoning,
    });
  }

  return { mixture: running, shape: computeShape(running), chain };
}
