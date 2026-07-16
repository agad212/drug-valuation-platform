import { describe, it, expect } from "vitest";
import { scoreMechanism, type FactorScore, type MechanismFactors } from "../ptrs-mechanism-scorer";
import { boundNullNegativeSignal } from "../evidence-discovery";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import type { TrialDesignInputs } from "../ptrs-trial";

const f = (score: number, highVariance = false): FactorScore => ({
  score, confidence: "medium", rationale: "", highVariance,
});

// Base factor set that (ungated) averages to a "moderate" MSS ~0.52, mirroring
// the live TTX-MC138 mechanism scores.
function factors(overrides: Partial<MechanismFactors> = {}): MechanismFactors {
  return {
    potency: f(0.45), selectivity: f(0.65), pkProfile: f(0.55),
    targetEngagement: f(0.55), therapeuticWindow: f(0.72),
    targetValidation: f(0.30, true), indicationMechFit: f(0.72),
    modalityFit: f(0.60), translationRate: f(0.15, true),
    ...overrides,
  };
}

describe("Part 3 — unvalidated-first-in-class composite gate", () => {
  it("gates MSS below 'moderate' when target-validation is capped and class unprecedented", () => {
    const gated = scoreMechanism(factors());
    // Same factors but target-validation just above the cap → gate does NOT fire.
    const ungated = scoreMechanism(factors({ targetValidation: f(0.40, true) }));
    // Ungated composite would be ~0.52; the gate caps it at targetValidation+0.12 = 0.42.
    expect(gated.mss).toBeLessThanOrEqual(0.42 + 1e-9);
    expect(gated.mss).toBeLessThan(0.5); // no longer "moderate-and-up"
    // The gate widens uncertainty relative to the ungated case (+0.08 term).
    expect(gated.variance).toBeGreaterThan(ungated.variance);
  });

  it("does NOT fire for a validated target — indication-fit is allowed to hold the score up", () => {
    // Validated target (0.85) + real class translation (0.55): gate condition false.
    const validated = scoreMechanism(factors({ targetValidation: f(0.85), translationRate: f(0.55) }));
    const ungatedMss = 0.5 * validated.ips + 0.5 * validated.trs;
    expect(validated.mss).toBeCloseTo(ungatedMss, 9); // not gated
    expect(validated.mss).toBeGreaterThan(0.5);
  });

  it("does NOT fire when the class HAS precedent even if a single factor is low", () => {
    const withPrecedent = scoreMechanism(factors({ translationRate: f(0.55) }));
    const ungatedMss = 0.5 * withPrecedent.ips + 0.5 * withPrecedent.trs;
    expect(withPrecedent.mss).toBeCloseTo(ungatedMss, 9);
  });
});

describe("Part 2 — own-clinical null-negative bounded pull", () => {
  const step = (mu: number, sigma2: number) => ({
    source: "own_clinical" as const, label: "x", found: true as const,
    signal: { mu, sigma2 }, reasoning: "",
  });

  it("clamps a neutralized null-negative signal into the bounded informative range", () => {
    // The live failure: model returned mu≈1.0 (regressed to base rate) + sigma2 0.52 (inflated).
    const bounded = boundNullNegativeSignal(step(1.0, 0.52), { efficacySignal: "null_negative" });
    expect(bounded.signal!.mu).toBeLessThanOrEqual(0.45);
    expect(bounded.signal!.mu).toBeGreaterThanOrEqual(0.30); // not cratered
    expect(bounded.signal!.sigma2).toBeLessThanOrEqual(0.42); // mismatch can't inflate to "no info"
    expect(bounded.signal!.sigma2).toBeGreaterThanOrEqual(0.25);
  });

  it("leaves a positive signal untouched", () => {
    const positive = boundNullNegativeSignal(step(1.3, 0.30), { efficacySignal: "positive" });
    expect(positive.signal!.mu).toBe(1.3);
    expect(positive.signal!.sigma2).toBe(0.30);
  });
});

describe("Part 4 — surrogate→hard-endpoint translation penalty", () => {
  const design: TrialDesignInputs = {
    n: 45, endpointType: "surrogate", designType: "single_arm",
    populationType: "biomarker_selected", placeboResponse: "low", regulatoryContext: "orphan",
  };
  function plan(ph3TTE: boolean) {
    const stages: DevStageInput[] = [
      { id: "s1", name: "Ph2a", phase: "Phase 2", n: 45, cpp: 185000, trialDesign: design,
        isCurrentTrial: true, enrollmentRatePerMonth: 3, treatmentObsMonths: 6, startupCushionMonths: 7,
        isTimeToEvent: false, nullResponseRate: 0.12 },
      { id: "s2", name: "Ph3", phase: "Phase 3", n: 280, cpp: 240000, isCurrentTrial: false,
        enrollmentRatePerMonth: 5, treatmentObsMonths: 12, startupCushionMonths: 8,
        isTimeToEvent: ph3TTE, nullResponseRate: 0.20,
        trialDesign: { ...design, n: 280, designType: "rct", populationType: "rare_small" } },
    ];
    return computeDevPlan(mixtureFromMssVariance(0.5, 0.2), 0.1, { stages, regulatoryContext: "orphan" }, 0);
  }

  it("lowers Phase 3 P(success) when a rate surrogate is followed by a TTE endpoint", () => {
    const withShift = plan(true);   // ctDNA (rate) → RFS (TTE): penalty applies
    const noShift = plan(false);    // both rate endpoints: no penalty
    const ph3WithShift = withShift.stages[1].trialSuccessProb;
    const ph3NoShift = noShift.stages[1].trialSuccessProb;
    expect(ph3WithShift).toBeLessThan(ph3NoShift);
  });
});
