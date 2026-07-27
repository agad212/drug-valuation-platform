import { describe, it, expect } from "vitest";
import { eventProbability, tteEventsFromAccrual, schoenfeldZ } from "../tte-power";
import { normalCDF } from "../effect-prior";
import { computeStageRR, rrTrialPower, mixtureToBeta, betaToGrid, gridMoments, type RRTrialDesign } from "../bayesian-rr";

// Layer 1, Phase 1 — design-aware power: alpha-as-parameter + native-TTE (Schoenfeld).
// Every assertion is falsifiable (a regression in the wiring or the math trips it). The FROZEN
// byte-identical proof (TTX 0.08986 / tau 0.26751 with new fields ABSENT) is the harness's job;
// here we prove the NEW paths fire, are correct, and stay single-locus.

const RCT: RRTrialDesign = { designType: "rct", endpointType: "surrogate", populationType: "broad", regulatoryContext: "standard" };
const SINGLE_ARM: RRTrialDesign = { designType: "single_arm", endpointType: "surrogate", populationType: "broad", regulatoryContext: "standard" };
const MIX = [{ w: 1, mu: 1.0, sigma2: 0.15 }]; // prior mean_rr ≈ 0.5
const priorMean = () => gridMoments(betaToGrid(mixtureToBeta(MIX))).mean;

// ══ tte-power PRIMITIVES — validated against known sample-size points (absolute correctness) ══
describe("Layer 1 — TTE primitives (Schoenfeld + accrual), known-point validation", () => {
  it("KNOWN POINT: HR 0.7 with ~247 events at one-sided α=0.025 (z=1.96) → ~80% power", () => {
    // Schoenfeld: d = 4(z_α+z_β)²/(ln HR)²; for HR .7, 80% power, α .025 → d ≈ 247.
    const power = normalCDF(schoenfeldZ(0.7, 247, 1.96));
    expect(power).toBeGreaterThan(0.79);
    expect(power).toBeLessThan(0.81);
  });

  it("no effect (HR=1) → power collapses to the type-I rate α (here z=1.96 → ~2.5%)", () => {
    expect(normalCDF(schoenfeldZ(1.0, 247, 1.96))).toBeCloseTo(0.025, 3);
  });

  it("more events → strictly more power (information, monotone)", () => {
    expect(normalCDF(schoenfeldZ(0.7, 400, 1.96))).toBeGreaterThan(normalCDF(schoenfeldZ(0.7, 100, 1.96)));
  });

  it("accrual sub-model: closed-form events match the hand-computed value (median 12, HR .7, A24/f12, n500 → ~334)", () => {
    const d = tteEventsFromAccrual({ controlMedianMonths: 12, accrualMonths: 24, followupMonths: 12, nTotal: 500 }, 0.7, 0.5);
    expect(d).toBeGreaterThan(330);
    expect(d).toBeLessThan(338);
  });

  it("dropout reduces observed events (competing risk)", () => {
    const base = tteEventsFromAccrual({ controlMedianMonths: 12, accrualMonths: 24, followupMonths: 12, nTotal: 500 }, 0.7, 0.5);
    const withDropout = tteEventsFromAccrual({ controlMedianMonths: 12, accrualMonths: 24, followupMonths: 12, dropoutHazardPerMonth: 0.02, nTotal: 500 }, 0.7, 0.5);
    expect(withDropout).toBeLessThan(base);
    expect(eventProbability(0.05, 24, 12, 0.02)).toBeLessThan(eventProbability(0.05, 24, 12, 0));
  });
});

// ══ ALPHA-AS-PARAMETER — free alpha REPLACES the category (never stacks), moves the bar only ══
describe("Layer 1 — alpha-as-parameter", () => {
  // The category z-constants (1.645, 1.96, 1.28) are ROUNDED; zFromAlpha returns the exact Φ⁻¹
  // (e.g. Φ⁻¹(0.975)=1.959964). So free alpha reproduces the category to ~1e-4 (the category's own
  // rounding), NOT to machine precision — and we must NOT make the category exact (that would move
  // tau, which is 'standard'→1.645, and break FROZEN). This agreement is the "REPLACE, not stack" proof.
  it("free alpha REPRODUCES the category it replaces (to the category's rounding): α=0.05 1-sided ≈ 'standard' (z≈1.645)", () => {
    const cat = rrTrialPower(0.5, 0.15, 100, RCT); // standard, no alpha
    const freeAlpha = rrTrialPower(0.5, 0.15, 100, { ...RCT, alpha: { value: 0.05, sided: 1 } });
    expect(freeAlpha).toBeCloseTo(cat, 3); // same bar up to the category's rounded constant
  });

  it("free α=0.025 one-sided ≈ 'confirmatory' category (z≈1.96)", () => {
    const cat = rrTrialPower(0.5, 0.15, 100, { ...RCT, regulatoryContext: "confirmatory" });
    const freeAlpha = rrTrialPower(0.5, 0.15, 100, { ...RCT, alpha: { value: 0.025, sided: 1 } });
    expect(freeAlpha).toBeCloseTo(cat, 3);
  });

  it("looser alpha → higher power; stricter → lower (moves the BAR, right direction)", () => {
    const loose = computeStageRR(MIX, 100, 0.15, { ...RCT, alpha: { value: 0.10, sided: 1 } }).trialSuccessProb;
    const strict = computeStageRR(MIX, 100, 0.15, { ...RCT, alpha: { value: 0.01, sided: 1 } }).trialSuccessProb;
    expect(loose).toBeGreaterThan(strict);
  });

  it("two-sided halves the tail (stricter than one-sided at the same α)", () => {
    const oneSided = rrTrialPower(0.5, 0.15, 100, { ...RCT, alpha: { value: 0.05, sided: 1 } });
    const twoSided = rrTrialPower(0.5, 0.15, 100, { ...RCT, alpha: { value: 0.05, sided: 2 } });
    expect(twoSided).toBeLessThan(oneSided);
  });
});

// ══ NATIVE-TTE via computeStageRR — the path FIRES, differs from the proxy, behaves correctly ══
describe("Layer 1 — native-TTE dispatch (RCT), gated on design.tte NOT isTimeToEvent", () => {
  it("FIRES + DIFFERS from the RR-proxy for the same RCT-TTE stage (proves the native branch executed)", () => {
    const proxy = computeStageRR(MIX, 200, 0.15, RCT, true).trialSuccessProb;
    const native = computeStageRR(MIX, 200, 0.15, { ...RCT, tte: { expectedHR: 0.6, events: 300 } }, true).trialSuccessProb;
    expect(native).not.toBeCloseTo(proxy, 3); // if native never fired, it would equal the proxy
  });

  it("stronger HR benefit → higher power (effect direction, via the prior→HR anchor)", () => {
    const strong = computeStageRR(MIX, 200, 0.15, { ...RCT, tte: { expectedHR: 0.5, events: 300 } }, true).trialSuccessProb;
    const weak = computeStageRR(MIX, 200, 0.15, { ...RCT, tte: { expectedHR: 0.85, events: 300 } }, true).trialSuccessProb;
    expect(strong).toBeGreaterThan(weak);
  });

  it("accrual sub-model path fires (events derived) and also differs from the proxy", () => {
    const proxy = computeStageRR(MIX, 200, 0.15, RCT, true).trialSuccessProb;
    const native = computeStageRR(
      MIX, 200, 0.15,
      { ...RCT, tte: { expectedHR: 0.65, accrual: { controlMedianMonths: 12, accrualMonths: 24, followupMonths: 12, nTotal: 400 } } },
      true,
    ).trialSuccessProb;
    expect(native).not.toBeCloseTo(proxy, 3);
  });

  it("FROZEN-SAFE gate: single-arm TTE does NOT fire native (RCT-only this pass) → identical to no-tte proxy", () => {
    const withTte = computeStageRR(MIX, 200, 0.15, { ...SINGLE_ARM, tte: { expectedHR: 0.6, events: 300 } }, true).trialSuccessProb;
    const noTte = computeStageRR(MIX, 200, 0.15, SINGLE_ARM, true).trialSuccessProb;
    expect(withTte).toBe(noTte); // single-arm stays on the RR-proxy, byte-identical
  });
});

// ══ SINGLE-LOCUS — design params move precision/bar only; the effect (prior) never moves ══
describe("Layer 1 — single-locus: effect stays in the prior", () => {
  it("vary ALPHA only → power moves via the bar; the prior mean is unchanged", () => {
    const before = priorMean();
    const loose = computeStageRR(MIX, 150, 0.15, { ...RCT, alpha: { value: 0.10, sided: 1 } }).trialSuccessProb;
    const strict = computeStageRR(MIX, 150, 0.15, { ...RCT, alpha: { value: 0.025, sided: 1 } }).trialSuccessProb;
    expect(loose).not.toBeCloseTo(strict, 4); // the design moved power
    expect(priorMean()).toBe(before); // …but the effect prior did not move
  });

  it("vary TTE PRECISION (events) only → power moves via √d; the prior mean is unchanged", () => {
    const before = priorMean();
    const few = computeStageRR(MIX, 200, 0.15, { ...RCT, tte: { expectedHR: 0.7, events: 100 } }, true).trialSuccessProb;
    const many = computeStageRR(MIX, 200, 0.15, { ...RCT, tte: { expectedHR: 0.7, events: 500 } }, true).trialSuccessProb;
    expect(many).toBeGreaterThan(few); // more information → more power
    expect(priorMean()).toBe(before); // …HR anchor + prior unchanged; only √d changed
  });
});
