import { describe, it, expect } from "vitest";
import {
  gaussianToBeta,
  mixtureToBeta,
  betaToGrid,
  gridMoments,
  gridToGaussianMixture,
  rrTrialPower,
  computeStageSuccess,
  posteriorAfterSuccess,
  posteriorFromObservedRR,
  computeBandMasses,
  lnGamma,
  betaPdf,
  computeStageRR,
  GRID_SIZE,
  type RRTrialDesign,
} from "../bayesian-rr";

// ─── Helper ──────────────────────────────────────────────────────────────

const RCT_DESIGN: RRTrialDesign = {
  designType: "rct",
  endpointType: "surrogate",
  populationType: "broad",
  regulatoryContext: "standard",
};

const SINGLE_ARM_DESIGN: RRTrialDesign = {
  designType: "single_arm",
  endpointType: "surrogate",
  populationType: "broad",
  regulatoryContext: "standard",
};

// ─── 1. gaussianToBeta round-trip ────────────────────────────────────────

describe("gaussianToBeta conversion", () => {
  it("maps mu=1.0, sigma2=0.20 to a Beta with mean ≈ 0.50 and correct variance", () => {
    // mu=1.0 in Gaussian space → mean_rr = 0.50
    // sigma2=0.20 → var_rr = 0.05
    const { alpha, beta } = gaussianToBeta(1.0, 0.20);
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));

    expect(mean).toBeCloseTo(0.50, 2);
    expect(variance).toBeCloseTo(0.05, 2);
    expect(alpha).toBeGreaterThan(0.5);
    expect(beta).toBeGreaterThan(0.5);
  });

  it("handles edge case: very high mu (strong drug)", () => {
    const { alpha, beta } = gaussianToBeta(1.6, 0.10);
    const mean = alpha / (alpha + beta);
    expect(mean).toBeCloseTo(0.80, 2);
    expect(alpha).toBeGreaterThan(beta); // high mean → α > β
  });

  it("handles edge case: very low mu (weak drug)", () => {
    // mu=0.4, sigma2=0.30 → mean_rr≈0.20, but high variance + alpha floor
    // clamp (α≥0.5) shifts the mean slightly upward. That's acceptable —
    // it prevents degenerate Beta shapes near the boundary.
    const { alpha, beta } = gaussianToBeta(0.4, 0.30);
    const mean = alpha / (alpha + beta);
    expect(mean).toBeCloseTo(0.20, 1); // within 0.05
    expect(mean).toBeLessThan(0.30);
    expect(beta).toBeGreaterThan(alpha);
  });

  it("grid round-trip: Gaussian → Beta → grid → moments ≈ original", () => {
    const mu = 1.0, sigma2 = 0.20;
    const betaMix = mixtureToBeta([{ w: 1, mu, sigma2 }]);
    const grid = betaToGrid(betaMix);
    const { mean, variance } = gridMoments(grid);

    expect(mean).toBeCloseTo(0.50, 2); // mu/2
    expect(variance).toBeCloseTo(0.05, 2); // sigma2/4
  });
});

// ─── 2. P(success) sanity ────────────────────────────────────────────────

describe("P(success) sanity checks", () => {
  it("prior centered at RR=0.40, null=0.20, n=100 RCT → P(success) is substantial", () => {
    // A drug with true RR ≈ 0.40 should have good odds beating null=0.20 with n=100
    // (note: with a diffuse prior, P(success) integrates lower than point power)
    const betaMix = mixtureToBeta([{ w: 1, mu: 0.80, sigma2: 0.08 }]); // mean_rr ≈ 0.40
    const grid = betaToGrid(betaMix);
    const pSuccess = computeStageSuccess(grid, 100, 0.20, RCT_DESIGN);

    expect(pSuccess).toBeGreaterThan(0.45);
    expect(pSuccess).toBeLessThan(1.0);
  });

  it("drug barely above null → P(success) is moderate", () => {
    // Drug with true RR ≈ 0.25 vs null of 0.20 — marginal
    const betaMix = mixtureToBeta([{ w: 1, mu: 0.50, sigma2: 0.04 }]); // mean_rr ≈ 0.25
    const grid = betaToGrid(betaMix);
    const pSuccess = computeStageSuccess(grid, 100, 0.20, RCT_DESIGN);

    expect(pSuccess).toBeGreaterThan(0.10);
    expect(pSuccess).toBeLessThan(0.70);
  });

  it("drug below null → P(success) is very low", () => {
    // Drug with true RR ≈ 0.10 vs null of 0.20 — should fail
    const betaMix = mixtureToBeta([{ w: 1, mu: 0.20, sigma2: 0.04 }]); // mean_rr ≈ 0.10
    const grid = betaToGrid(betaMix);
    const pSuccess = computeStageSuccess(grid, 100, 0.20, RCT_DESIGN);

    expect(pSuccess).toBeLessThan(0.10);
  });

  it("rrTrialPower: power at θ=0.40, null=0.20, n=200 RCT ≈ standard power calc", () => {
    // Manual: SE = sqrt((0.4*0.6 + 0.2*0.8)/100) = sqrt(0.004) = 0.0632
    // z = (0.40 - 0.20)/0.0632 - 1.645 = 3.164 - 1.645 = 1.519
    // Φ(1.519) ≈ 0.936
    const power = rrTrialPower(0.40, 0.20, 200, RCT_DESIGN);
    expect(power).toBeCloseTo(0.936, 1);
  });
});

// ─── 3. Posterior normalization + direction ───────────────────────────────

describe("posterior after success", () => {
  it("posterior is normalized (integrates to ~1)", () => {
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.0, sigma2: 0.20 }]);
    const prior = betaToGrid(betaMix);
    const posterior = posteriorAfterSuccess(prior, 100, 0.15, RCT_DESIGN);

    const total = posterior.density.reduce((s, d) => s + d, 0)
      * (posterior.theta[1] - posterior.theta[0]);
    expect(total).toBeCloseTo(1.0, 1);
  });

  it("posterior mean shifts UP after success", () => {
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.0, sigma2: 0.20 }]);
    const prior = betaToGrid(betaMix);
    const posterior = posteriorAfterSuccess(prior, 100, 0.15, RCT_DESIGN);

    const priorMean = gridMoments(prior).mean;
    const postMean = gridMoments(posterior).mean;
    expect(postMean).toBeGreaterThan(priorMean);
  });

  it("posterior variance SHRINKS after success", () => {
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.0, sigma2: 0.20 }]);
    const prior = betaToGrid(betaMix);
    const posterior = posteriorAfterSuccess(prior, 100, 0.15, RCT_DESIGN);

    const priorVar = gridMoments(prior).variance;
    const postVar = gridMoments(posterior).variance;
    expect(postVar).toBeLessThan(priorVar);
  });
});

// ─── 4. Small n vs large n tightening (THE KEY TEST) ─────────────────────

describe("trial size affects posterior tightening", () => {
  it("n=45 single-arm tightens LESS than n=220 RCT", () => {
    // Use a prior that STRADDLES the null threshold — this is where
    // trial size matters most (the prior has real mass both above
    // and below the threshold, so the trial's discrimination matters).
    const betaMix = mixtureToBeta([{ w: 1, mu: 0.60, sigma2: 0.30 }]);
    // mean_rr ≈ 0.30, var_rr ≈ 0.075 → broad, uncertain prior
    const prior = betaToGrid(betaMix);
    const priorVar = gridMoments(prior).variance;

    // Small trial: Phase 2, single-arm, n=45
    const postSmall = posteriorAfterSuccess(prior, 45, 0.15, SINGLE_ARM_DESIGN);
    const smallVar = gridMoments(postSmall).variance;

    // Large trial: Phase 3, RCT, n=220
    const postLarge = posteriorAfterSuccess(prior, 220, 0.15, RCT_DESIGN);
    const largeVar = gridMoments(postLarge).variance;

    // Both should tighten (variance decreases)
    expect(smallVar).toBeLessThan(priorVar);
    expect(largeVar).toBeLessThan(priorVar);

    // THE KEY: large trial tightens MORE (lower variance)
    expect(largeVar).toBeLessThan(smallVar);
  });
});

// ─── 5. Observed-result mode ─────────────────────────────────────────────

describe("observed-result mode", () => {
  it("entering 64% ORR at n=16 produces a modest update (small n)", () => {
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.0, sigma2: 0.20 }]);
    const prior = betaToGrid(betaMix);
    const priorMoments = gridMoments(prior);

    // Observed: 64% ORR in a Phase 1a with only 16 patients
    const posterior = posteriorFromObservedRR(prior, 0.64, 16);
    const postMoments = gridMoments(posterior);

    // Mean should shift toward 0.64 but only modestly (small n = weak evidence)
    expect(postMoments.mean).toBeGreaterThan(priorMoments.mean);
    expect(postMoments.mean).toBeLessThan(0.64); // shouldn't jump all the way to observed

    // Variance should shrink (even n=16 provides real information via binomial likelihood)
    expect(postMoments.variance).toBeLessThan(priorMoments.variance);
  });

  it("observed-result updates MORE precisely than success-event mode", () => {
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.0, sigma2: 0.20 }]);
    const prior = betaToGrid(betaMix);

    const postSuccess = posteriorAfterSuccess(prior, 100, 0.15, RCT_DESIGN);
    const postObserved = posteriorFromObservedRR(prior, 0.45, 100);

    // Observed mode should give a tighter (lower variance) posterior
    // because it uses the EXACT result, not just pass/fail
    const successVar = gridMoments(postSuccess).variance;
    const observedVar = gridMoments(postObserved).variance;
    expect(observedVar).toBeLessThan(successVar);
  });
});

// ─── 6. Mixture reweighting ──────────────────────────────────────────────

describe("mixture component reweighting", () => {
  it("higher-RR component gains weight after success", () => {
    // Bimodal mixture: 50% chance drug is weak (RR≈0.15), 50% strong (RR≈0.50)
    const gaussMix = [
      { w: 0.5, mu: 0.30, sigma2: 0.04 }, // weak: mean_rr ≈ 0.15
      { w: 0.5, mu: 1.00, sigma2: 0.04 }, // strong: mean_rr ≈ 0.50
    ];

    const result = computeStageRR(gaussMix, 100, 0.15, RCT_DESIGN);

    // After success, the posterior should favor the strong component
    // (higher RR → higher P(success) → gains Bayesian weight)
    // We check this indirectly: posterior mean should shift toward the strong component
    expect(result.posteriorMean).toBeGreaterThan(result.priorMean);

    // The bands should show less mass below threshold after success
    expect(result.bandsAfter.belowThreshold).toBeLessThan(result.bandsBefore.belowThreshold);
    expect(result.bandsAfter.strong).toBeGreaterThan(result.bandsBefore.strong);
  });
});

// ─── 7. Band mass conservation ───────────────────────────────────────────

describe("band masses", () => {
  it("masses sum to ~1.0 for prior", () => {
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.0, sigma2: 0.20 }]);
    const grid = betaToGrid(betaMix);
    const bands = computeBandMasses(grid, 0.15);

    const total = bands.belowThreshold + bands.modest + bands.strong;
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("masses sum to ~1.0 for posterior", () => {
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.0, sigma2: 0.20 }]);
    const grid = betaToGrid(betaMix);
    const posterior = posteriorAfterSuccess(grid, 100, 0.15, RCT_DESIGN);
    const bands = computeBandMasses(posterior, 0.15);

    const total = bands.belowThreshold + bands.modest + bands.strong;
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("band boundaries make sense", () => {
    // Drug strongly above null → most mass in "strong"
    const betaMix = mixtureToBeta([{ w: 1, mu: 1.4, sigma2: 0.06 }]); // mean_rr ≈ 0.70
    const grid = betaToGrid(betaMix);
    const bands = computeBandMasses(grid, 0.15);

    expect(bands.strong).toBeGreaterThan(0.5); // most mass above nullRR + 0.20
    expect(bands.belowThreshold).toBeLessThan(0.1); // little mass below null
  });
});

// ─── Math primitives ─────────────────────────────────────────────────────

describe("lnGamma", () => {
  it("lnGamma(1) = 0 (Γ(1) = 0! = 1)", () => {
    expect(lnGamma(1)).toBeCloseTo(0, 10);
  });

  it("lnGamma(5) = ln(4!) = ln(24) ≈ 3.178", () => {
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 5);
  });

  it("lnGamma(0.5) = ln(√π) ≈ 0.5724", () => {
    expect(lnGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 5);
  });
});

describe("betaPdf", () => {
  it("Beta(1,1) = Uniform(0,1) → pdf = 1 everywhere", () => {
    expect(betaPdf(0.3, 1, 1)).toBeCloseTo(1.0, 5);
    expect(betaPdf(0.7, 1, 1)).toBeCloseTo(1.0, 5);
  });

  it("Beta(2,2) is symmetric with peak at 0.5", () => {
    const atHalf = betaPdf(0.5, 2, 2);
    const atQuarter = betaPdf(0.25, 2, 2);
    expect(atHalf).toBeGreaterThan(atQuarter);
    expect(betaPdf(0.25, 2, 2)).toBeCloseTo(betaPdf(0.75, 2, 2), 10); // symmetric
  });
});
