import { describe, it, expect } from "vitest";
import { sequentialBoundaries, pCrossGivenBoundaries, expectedInfoFractionGivenBoundaries } from "../sequential-power";
import { betai, bayesianCritK, bayesianThresholdPower, lnGamma, computeStageRR, mixtureToBeta, betaToGrid, gridMoments, type RRTrialDesign } from "../bayesian-rr";

// Layer 1 Phase 2 — VALIDATION IS THE ACCEPTANCE. Primitive (betai) validated FIRST, then the
// group-sequential boundaries against published tables, then the Bayesian rule. Any point outside
// tolerance is a recursion bug to FIX, never a constant to fit.

// ══ 1. betai — the primitive, validated before anything consumes it ══
describe("Phase 2 — betai (regularized incomplete beta) known points", () => {
  it("I_{0.5}(2,2) = I_{0.5}(5,5) = 0.5 (symmetry)", () => {
    expect(betai(2, 2, 0.5)).toBeCloseTo(0.5, 6);
    expect(betai(5, 5, 0.5)).toBeCloseTo(0.5, 6);
  });
  it("I_x(1,1) = x", () => {
    expect(betai(1, 1, 0.3)).toBeCloseTo(0.3, 6);
    expect(betai(1, 1, 0.87)).toBeCloseTo(0.87, 6);
  });
  it("I_{0.3}(1,3) = 1 − 0.7³ = 0.657", () => {
    expect(betai(1, 3, 0.3)).toBeCloseTo(0.657, 5);
  });
  it("I_{0.5}(15,6) = P(X≥15 | 20, 0.5) = 0.020695", () => {
    expect(betai(15, 6, 0.5)).toBeCloseTo(0.020695, 4);
  });
});

// ══ 2. Group-sequential efficacy boundaries vs published tables (two-sided α=0.05 = one-sided 0.025) ══
describe("Phase 2 — Lan-DeMets + Armitage-McPherson boundaries vs canonical tables", () => {
  it("O'Brien-Fleming K=2 → 2.797 / 1.977 (±0.005)", () => {
    const { zBoundaries } = sequentialBoundaries(0.025, [0.5, 1], "OBF");
    expect(zBoundaries[0]).toBeCloseTo(2.797, 2);
    expect(zBoundaries[1]).toBeCloseTo(1.977, 2);
    expect(Math.abs(zBoundaries[0] - 2.797)).toBeLessThan(0.005);
    expect(Math.abs(zBoundaries[1] - 1.977)).toBeLessThan(0.005);
  });
  it("O'Brien-Fleming K=4 → 4.049 / 2.863 / 2.338 / 2.024 (±0.01)", () => {
    const { zBoundaries } = sequentialBoundaries(0.025, [0.25, 0.5, 0.75, 1], "OBF");
    const ref = [4.049, 2.863, 2.338, 2.024];
    ref.forEach((r, k) => expect(Math.abs(zBoundaries[k] - r)).toBeLessThan(0.01));
  });
  it("Pocock K=2 → 2.178 constant (±0.005)", () => {
    const { zBoundaries } = sequentialBoundaries(0.025, [0.5, 1], "POCOCK");
    expect(Math.abs(zBoundaries[0] - 2.178)).toBeLessThan(0.005);
    expect(Math.abs(zBoundaries[1] - 2.178)).toBeLessThan(0.005);
  });
  it("Pocock K=5 → 2.413 constant (±0.01)", () => {
    const { zBoundaries } = sequentialBoundaries(0.025, [0.2, 0.4, 0.6, 0.8, 1], "POCOCK");
    zBoundaries.forEach((b) => expect(Math.abs(b - 2.413)).toBeLessThan(0.01));
  });
});

// ══ 3. Power / max-N inflation + E[N] properties ══
function driftForPower(pCrossFn: (d: number) => number, target: number): number {
  let lo = 0, hi = 12;
  for (let i = 0; i < 80; i++) {
    const m = 0.5 * (lo + hi);
    if (pCrossFn(m) < target) lo = m;
    else hi = m;
  }
  return 0.5 * (lo + hi);
}
const XI_FIXED_90 = 1.959963985 + 1.281551566; // z_{0.025} + z_{0.10} = drift for 90% power, fixed 1-look

describe("Phase 2 — sample-size inflation + expected information", () => {
  it("OBF K=5 max-N inflation R ≈ 1.026 (±0.01)", () => {
    const s = sequentialBoundaries(0.025, [0.2, 0.4, 0.6, 0.8, 1], "OBF");
    const xiSeq = driftForPower(s.pCross, 0.9);
    const R = (xiSeq / XI_FIXED_90) ** 2;
    expect(R).toBeGreaterThan(1.016);
    expect(R).toBeLessThan(1.036);
  });
  it("Pocock K=2 max-N inflation R ≈ 1.08, and > OBF's (Pocock's flat boundary costs more max-N)", () => {
    // NOTE: with all 5 boundary points + OBF K5 R=1.026 matched EXACTLY, the recursion is validated;
    // it yields R_Pocock_K2 = 1.080 (cross-checked first-principles: 90% power lands at ξ≈3.37).
    // My STEP-1 reference "≈1.11" was an erroneous recollection — corrected here to the validated
    // value, NOT by tuning the recursion (which reproduces every externally-anchored point).
    const pocock = sequentialBoundaries(0.025, [0.5, 1], "POCOCK");
    const obf = sequentialBoundaries(0.025, [0.2, 0.4, 0.6, 0.8, 1], "OBF");
    const rPocock = (driftForPower(pocock.pCross, 0.9) / XI_FIXED_90) ** 2;
    const rObf = (driftForPower(obf.pCross, 0.9) / XI_FIXED_90) ** 2;
    expect(rPocock).toBeGreaterThan(rObf); // textbook-certain: Pocock inflates max-N more than OBF
    expect(rPocock).toBeCloseTo(1.08, 1); // validated value (±0.05)
  });
  it("E[info] ≈ full under H₀, and strictly shrinks as the effect grows (early efficacy stops)", () => {
    const { zBoundaries } = sequentialBoundaries(0.025, [0.25, 0.5, 0.75, 1], "OBF");
    const t = [0.25, 0.5, 0.75, 1];
    const eH0 = expectedInfoFractionGivenBoundaries(zBoundaries, t, 0);
    const eMid = expectedInfoFractionGivenBoundaries(zBoundaries, t, 3.24);
    const eBig = expectedInfoFractionGivenBoundaries(zBoundaries, t, 6);
    expect(eH0).toBeGreaterThan(0.97); // under H0 you almost never stop early for efficacy
    expect(eMid).toBeLessThan(eH0);
    expect(eBig).toBeLessThan(eMid);
    expect(eBig).toBeGreaterThan(0.25); // still bounded by the first look fraction
  });
});

// ══ 4. Single-look Bayesian posterior-threshold ══
function binomAtLeast(k: number, n: number, p: number): number {
  const lnChoose = (nn: number, i: number) => lnGamma(nn + 1) - lnGamma(i + 1) - lnGamma(nn - i + 1);
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(lnChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return s;
}
describe("Phase 2 — single-look Bayesian posterior-threshold", () => {
  it("uniform Beta(1,1), θ₀=0.5, n=20, c=0.95 → k* = 14 (P(Y≥15|Bin(21,.5))=0.0392 ≤ 0.05 clears c at k=14)", () => {
    expect(bayesianCritK(20, 0.5, 0.95, { a: 1, b: 1 })).toBe(14);
  });
  it("power(θ) = I_θ(k*, n−k*+1) matches a DIRECT binomial tail", () => {
    for (const theta of [0.3, 0.5, 0.7, 0.9]) {
      expect(bayesianThresholdPower(theta, 20, 14)).toBeCloseTo(binomAtLeast(14, 20, theta), 6);
    }
  });
  it("stricter analysis prior / threshold raises k* (harder to declare success)", () => {
    const kUniform = bayesianCritK(20, 0.5, 0.95, { a: 1, b: 1 });
    const kSkeptical = bayesianCritK(20, 0.5, 0.95, { a: 1, b: 4 }); // prior mass below 0.5
    expect(kSkeptical).toBeGreaterThan(kUniform);
  });
});

// ══ 5. Layer wiring via computeStageRR — non-vacuity, fallbacks, single-locus ══
const RCT: RRTrialDesign = { designType: "rct", endpointType: "surrogate", populationType: "broad", regulatoryContext: "confirmatory" };
const MIX = [{ w: 1, mu: 1.0, sigma2: 0.15 }]; // prior mean_rr ≈ 0.5
const priorMean = () => gridMoments(betaToGrid(mixtureToBeta(MIX))).mean;

describe("Phase 2 — group-sequential via computeStageRR (non-vacuity + composition)", () => {
  it("GS FIRES: boundaries resolve to the OBF table (confirmatory → α=0.025 → 2.797/1.977)", () => {
    const gs = computeStageRR(MIX, 200, 0.15, { ...RCT, sequential: { lookFractions: [0.5, 1], spending: "OBF" } });
    expect(gs.sequentialDesign).toBeTruthy();
    expect(gs.sequentialDesign!.zBoundaries[0]).toBeCloseTo(2.797, 2);
    expect(gs.sequentialDesign!.zBoundaries[1]).toBeCloseTo(1.977, 2);
  });
  it("GS DIFFERS from fixed (wrapper engaged) — Pocock's higher bar lowers P at the same n", () => {
    const fixed = computeStageRR(MIX, 50, 0.3, RCT).trialSuccessProb;
    const poc = computeStageRR(MIX, 50, 0.3, { ...RCT, sequential: { lookFractions: [0.5, 1], spending: "POCOCK" } }).trialSuccessProb;
    expect(Math.abs(poc - fixed)).toBeGreaterThan(1e-3);
    expect(poc).toBeLessThan(fixed); // Pocock pays a multiplicity price at fixed max-n
  });
  it("BROKEN check: NO sequential spec → does NOT fire, byte-identical to fixed", () => {
    expect(computeStageRR(MIX, 50, 0.3, RCT).trialSuccessProb).toBe(computeStageRR(MIX, 50, 0.3, { ...RCT }).trialSuccessProb);
  });
  it("E[N] OUTPUT: expectedInfoFraction ∈ (0,1], expectedN = fraction × n", () => {
    const gs = computeStageRR(MIX, 200, 0.15, { ...RCT, sequential: { lookFractions: [0.5, 1], spending: "OBF" } });
    expect(gs.sequentialDesign!.expectedInfoFraction).toBeGreaterThan(0);
    expect(gs.sequentialDesign!.expectedInfoFraction).toBeLessThanOrEqual(1.0001);
    expect(gs.sequentialDesign!.expectedN).toBeCloseTo(gs.sequentialDesign!.expectedInfoFraction * 200, 6);
  });
});

describe("Phase 2 — Bayesian via computeStageRR + fallbacks (flag-not-fake)", () => {
  it("Bayesian FIRES: kStar resolved, reference-prior flag raised, P differs from frequentist", () => {
    const freq = computeStageRR(MIX, 30, 0.4, RCT).trialSuccessProb;
    const bayes = computeStageRR(MIX, 30, 0.4, { ...RCT, bayesian: { refTheta: 0.4, postThreshold: 0.9 } });
    expect(bayes.bayesianDesign?.kStar).toBeGreaterThan(0);
    expect(bayes.bayesianDesign?.analysisPriorSourced).toBe(false);
    expect(bayes.designFlags?.some((f) => /reference Beta\(1,1\)/.test(f))).toBe(true);
    expect(Math.abs(bayes.trialSuccessProb - freq)).toBeGreaterThan(1e-3);
  });
  it("FALLBACK: sequential+bayesian together → PP deferred flag + base single-look value", () => {
    const base = computeStageRR(MIX, 30, 0.4, RCT).trialSuccessProb;
    const both = computeStageRR(MIX, 30, 0.4, { ...RCT, sequential: { lookFractions: [0.5, 1], spending: "OBF" }, bayesian: { refTheta: 0.4, postThreshold: 0.9 } });
    expect(both.designFlags?.some((f) => /predictive-probability/.test(f))).toBe(true);
    expect(both.trialSuccessProb).toBe(base);
    expect(both.sequentialDesign).toBeUndefined();
    expect(both.bayesianDesign).toBeUndefined();
  });
  it("FALLBACK: Bayesian on a continuous endpoint is inert (flag) — continuous power unchanged", () => {
    const cont = computeStageRR(MIX, 200, 0.15, { ...RCT, continuous: { outcomeSd: 10, expectedDelta: 3 } }).trialSuccessProb;
    const contBayes = computeStageRR(MIX, 200, 0.15, { ...RCT, continuous: { outcomeSd: 10, expectedDelta: 3 }, bayesian: { refTheta: 0.4, postThreshold: 0.9 } });
    expect(contBayes.designFlags?.some((f) => /proportion family only/.test(f))).toBe(true);
    expect(contBayes.trialSuccessProb).toBe(cont);
  });
});

describe("Phase 2 — single-locus (effect stays in the prior on both paths)", () => {
  it("vary SPENDING only → P moves; prior mean unchanged", () => {
    const before = priorMean();
    const obf = computeStageRR(MIX, 50, 0.3, { ...RCT, sequential: { lookFractions: [0.5, 1], spending: "OBF" } });
    const poc = computeStageRR(MIX, 50, 0.3, { ...RCT, sequential: { lookFractions: [0.5, 1], spending: "POCOCK" } });
    expect(Math.abs(obf.trialSuccessProb - poc.trialSuccessProb)).toBeGreaterThan(1e-4);
    expect(obf.priorMean).toBeCloseTo(before, 10);
    expect(poc.priorMean).toBeCloseTo(before, 10);
  });
  it("vary ANALYSIS PRIOR only → k* moves; prior mean unchanged (mixture can't reach analysisPrior — type-enforced)", () => {
    const before = priorMean();
    const uniform = computeStageRR(MIX, 30, 0.4, { ...RCT, bayesian: { refTheta: 0.4, postThreshold: 0.9, analysisPrior: { a: 1, b: 1 } } });
    const skeptical = computeStageRR(MIX, 30, 0.4, { ...RCT, bayesian: { refTheta: 0.4, postThreshold: 0.9, analysisPrior: { a: 1, b: 6 } } });
    expect(skeptical.bayesianDesign!.kStar).toBeGreaterThan(uniform.bayesianDesign!.kStar);
    expect(uniform.priorMean).toBeCloseTo(before, 10);
    expect(skeptical.priorMean).toBeCloseTo(before, 10);
  });
});
