import { describe, it, expect } from "vitest";
import { scoreMechanism, type FactorScore, type MechanismFactors } from "../ptrs-mechanism-scorer";
import { boundNullNegativeSignal } from "../evidence-discovery";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { computeStageRR, MEANINGFUL_RR_FLOOR } from "../bayesian-rr";
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
    // Compare RAW (pre-ceiling) so the surrogate-penalty effect is isolated from the ceiling.
    const ph3WithShift = withShift.stages[1].trialSuccessProbRaw;
    const ph3NoShift = noShift.stages[1].trialSuccessProbRaw;
    expect(ph3WithShift).toBeLessThan(ph3NoShift);
  });
});

describe("Part-final — modality meta-risk haircut (class-conditioned)", () => {
  const design: TrialDesignInputs = {
    n: 45, endpointType: "surrogate", designType: "single_arm",
    populationType: "biomarker_selected", placeboResponse: "low", regulatoryContext: "orphan",
  };
  function planFor(classStatus: "graveyard" | "precedent" | undefined) {
    const stages: DevStageInput[] = [
      { id: "s1", name: "Ph2a", phase: "Phase 2", n: 45, cpp: 150000, trialDesign: design,
        isCurrentTrial: true, enrollmentRatePerMonth: 3, treatmentObsMonths: 6, startupCushionMonths: 7,
        isTimeToEvent: false, nullResponseRate: 0.05 },
      { id: "s2", name: "Ph3", phase: "Phase 3", n: 200, cpp: 300000, isCurrentTrial: false,
        enrollmentRatePerMonth: 5, treatmentObsMonths: 12, startupCushionMonths: 8,
        isTimeToEvent: true, nullResponseRate: 0.20,
        trialDesign: { ...design, n: 200, designType: "rct", populationType: "rare_small" } },
    ];
    return computeDevPlan(mixtureFromMssVariance(0.35, 0.15), 0.1,
      { stages, regulatoryContext: "orphan", modalityClassStatus: classStatus }, 0);
  }

  it("FIRES for a graveyard class: haircuts each trial-success stage and compounds", () => {
    const graveyard = planFor("graveyard");
    for (const st of graveyard.stages) {
      expect(st.modalityHaircut).toBeCloseTo(0.80, 6);
      // final = (raw capped at the base-rate ceiling) × haircut
      const capped = st.successCeilingBound ?? st.trialSuccessProbRaw;
      expect(st.trialSuccessProb).toBeCloseTo(capped * 0.80, 6);
    }
    // Compounds: overall P(approval) is strictly below the no-haircut baseline.
    expect(graveyard.pApproval).toBeLessThan(planFor(undefined).pApproval);
  });

  it("does NOT fire for a validated (precedent) class — the tau guard", () => {
    const precedent = planFor("precedent");
    const none = planFor(undefined);
    for (const st of precedent.stages) {
      expect(st.modalityHaircut).toBe(1.0);
      const capped = st.successCeilingBound ?? st.trialSuccessProbRaw;
      expect(st.trialSuccessProb).toBeCloseTo(capped, 9);
    }
    expect(precedent.pApproval).toBeCloseTo(none.pApproval, 9);
  });
});

describe("Part-final — base-rate ceilings + stage-integral stability (general)", () => {
  const tightDesign: TrialDesignInputs = {
    n: 600, endpointType: "surrogate", designType: "rct",
    populationType: "biomarker_selected", placeboResponse: "low", regulatoryContext: "btd",
  };
  // A well-powered RCT with a strong effect vs a tight, well-studied comparator —
  // the saturation setup that produced tau's non-credible 96%.
  function saturatingPlan(mss: number, phase: "Phase 2" | "Phase 3") {
    const stages: DevStageInput[] = [
      { id: "s1", name: "cur", phase, n: 600, cpp: 200000, trialDesign: tightDesign,
        isCurrentTrial: true, enrollmentRatePerMonth: 10, treatmentObsMonths: 12, startupCushionMonths: 5,
        isTimeToEvent: false, nullResponseRate: 0.20, comparatorSigma2: 0.004 },
    ];
    return computeDevPlan(mixtureFromMssVariance(mss, 0.08), 0.1, { stages, regulatoryContext: "btd" }, 0);
  }

  it("(i) a tight-comparator stage no longer saturates above the general ceiling", () => {
    const plan = saturatingPlan(0.75, "Phase 2");
    const st = plan.stages[0];
    expect(st.trialSuccessProbRaw).toBeGreaterThan(0.9); // raw integral WOULD saturate
    expect(st.trialSuccessProb).toBeLessThanOrEqual(0.90 + 1e-9); // capped
    expect(st.successCeilingBound).toBe(0.90);
  });

  it("(i-b) a confirmatory (Phase 3) stage is capped at the lower late-phase ceiling", () => {
    const st = saturatingPlan(0.75, "Phase 3").stages[0];
    expect(st.trialSuccessProb).toBeLessThanOrEqual(0.80 + 1e-9);
    expect(st.successCeilingBound).toBe(0.80);
  });

  it("(ii) a small prior perturbation produces only a small stage-probability change (no knife-edge)", () => {
    // Same fixture, effect prior nudged 2 points — compare the RAW integral (pre-ceiling).
    const a = saturatingPlan(0.50, "Phase 2").stages[0].trialSuccessProbRaw;
    const b = saturatingPlan(0.52, "Phase 2").stages[0].trialSuccessProbRaw;
    expect(Math.abs(a - b)).toBeLessThan(0.10); // smooth, not a cliff
  });
});

// Regression for the tau 0.0% incident: an UN-PINNED (LLM-derived, non-CRC)
// comparator was set above the entire effect prior, forcing "100% below threshold"
// and zeroing the integral. These exercise the FULL runtime path — comparator
// derivation included, NOT a fixed comparator — so they fail on the pre-fix engine
// (which returned ~0) and pass on the fixed one.
describe("Regression — un-pinned comparator cannot zero a non-degenerate prior (tau incident)", () => {
  const rrDesign = {
    designType: "rct" as const, endpointType: "surrogate" as const,
    populationType: "broad" as const, regulatoryContext: "standard" as const,
  };
  const healthyPrior = mixtureFromMssVariance(0.5, 0.12); // priorMean ≈ 0.5, non-degenerate

  it("a pathological SOC threshold (0.80) above the prior mean does NOT zero P(success)", () => {
    const bad = computeStageRR(healthyPrior, 300, 0.80, rrDesign, false);
    expect(bad.comparatorUnreliable).toBe(true);
    expect(bad.effectiveNullRR).toBeCloseTo(MEANINGFUL_RR_FLOOR, 6); // discarded → clinical floor
    expect(bad.trialSuccessProb).toBeGreaterThan(0.05);              // NOT a definitional 0
    expect(bad.bandsBefore.belowThreshold).toBeLessThan(0.999);      // not "100% below threshold"
  });

  it("a legitimate low comparator (below the prior mean) is untouched — no flag, no rescue", () => {
    const good = computeStageRR(healthyPrior, 300, 0.12, rrDesign, false);
    expect(good.comparatorUnreliable).toBe(false);
    expect(good.effectiveNullRR).toBeCloseTo(0.12, 6);
  });

  it("keys on the prior relationship, not an absolute ceiling: a high-but-valid SOC below a higher prior is untouched", () => {
    const strongPrior = mixtureFromMssVariance(0.7, 0.10); // priorMean ≈ 0.7
    const r = computeStageRR(strongPrior, 300, 0.55, rrDesign, false); // 0.55 < 0.7 → legit
    expect(r.comparatorUnreliable).toBe(false);
    expect(r.effectiveNullRR).toBeCloseTo(0.55, 6);
  });

  it("the 'harder bar' counterfactual moves in the correct direction (no inversion)", () => {
    const r = computeStageRR(healthyPrior, 300, 0.80, rrDesign, false);
    const harder = r.counterfactuals.find((c) => /harder bar/i.test(c.label));
    if (harder) expect(harder.pSuccess).toBeLessThanOrEqual(r.trialSuccessProb + 1e-9);
  });

  it("full computeDevPlan path: a stage with a corrupted 0.80 SOC still yields non-zero P(approval)", () => {
    const design: TrialDesignInputs = {
      n: 300, endpointType: "surrogate", designType: "rct",
      populationType: "broad", placeboResponse: "high", regulatoryContext: "standard",
    };
    const stages: DevStageInput[] = [
      { id: "s1", name: "Ph2", phase: "Phase 2", n: 300, cpp: 200000, trialDesign: design,
        isCurrentTrial: true, enrollmentRatePerMonth: 10, treatmentObsMonths: 12, startupCushionMonths: 6,
        isTimeToEvent: false, nullResponseRate: 0.80 },
    ];
    const plan = computeDevPlan(mixtureFromMssVariance(0.5, 0.12), 0.1,
      { stages, regulatoryContext: "standard" }, 1000);
    expect(plan.stages[0].comparatorUnreliable).toBe(true);
    expect(plan.stages[0].trialSuccessProb).toBeGreaterThan(0.05);
    expect(plan.pApproval).toBeGreaterThan(0);
  });
});
