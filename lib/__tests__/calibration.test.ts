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
  // A well-powered RCT with a maximal effect prior vs a near-point comparator — the saturation setup.
  // FIXTURE RESCALED with 2.2 (§1.6): under the old absolute map, mss 0.75 asserted a 37-point margin
  // and raw P saturated at ~0.96 on ordinary fixtures — the ceilings were capping an inflated number
  // (that was the 2.2 bug). On the anchored map an ORDINARY strong asset no longer saturates (see the
  // new (i-c) below), so keeping this guard NON-VACUOUS requires the honest extreme: maximal evidence
  // (mss 1.0 → μ = 2.0, a doubling over the comparator) against a near-point benchmark.
  function saturatingPlan(mss: number, phase: "Phase 2" | "Phase 3") {
    const stages: DevStageInput[] = [
      { id: "s1", name: "cur", phase, n: 600, cpp: 200000, trialDesign: tightDesign,
        isCurrentTrial: true, enrollmentRatePerMonth: 10, treatmentObsMonths: 12, startupCushionMonths: 5,
        isTimeToEvent: false, nullResponseRate: 0.20, comparatorSigma2: 0.0005 },
    ];
    return computeDevPlan(mixtureFromMssVariance(mss, 0.08), 0.1, { stages, regulatoryContext: "btd" }, 0);
  }

  it("(i) a saturating stage is capped at the general ceiling (the backstop still bites)", () => {
    const plan = saturatingPlan(1.0, "Phase 2");
    const st = plan.stages[0];
    expect(st.trialSuccessProbRaw).toBeGreaterThan(0.9); // raw integral genuinely saturates
    expect(st.trialSuccessProb).toBeLessThanOrEqual(0.90 + 1e-9); // capped
    expect(st.successCeilingBound).toBe(0.90);
  });

  it("(i-b) a confirmatory (Phase 3) stage is capped at the lower late-phase ceiling", () => {
    const st = saturatingPlan(1.0, "Phase 3").stages[0];
    expect(st.trialSuccessProb).toBeLessThanOrEqual(0.80 + 1e-9);
    expect(st.successCeilingBound).toBe(0.80);
  });

  it("(i-c) THE 2.2 FIX ITSELF: an ordinary strong asset no longer saturates — the ceiling stays idle", () => {
    // mss 0.75 (μ = 1.5, an above-average margin) with the ORIGINAL benchmark width (0.004 — a
    // near-point 0.0005 comparator saturates even μ=1.5). This is the exact configuration that used
    // to produce the raw ~96% the ceiling had to cap; on the anchored scale the raw integral is an
    // honest probability below the cap, so the ceiling never fires.
    // RECONCILED (§1.6, concurrent-control rule): benchmark σ² now only applies to designs judged
    // against an EXTERNAL benchmark — the scenario this test always described ("benchmark width").
    // The stage is therefore SINGLE-ARM at n=300, the like-for-like exposure of the original
    // 600-patient RCT (300/arm); on an RCT the same σ² is rightly excluded (its own test lives in
    // elicitation.test.ts) and a μ=1.5 RCT saturating honestly at that n is not a pathology.
    const stages: DevStageInput[] = [
      { id: "s1", name: "cur", phase: "Phase 2", n: 300, cpp: 200000,
        trialDesign: { ...tightDesign, designType: "single_arm" },
        isCurrentTrial: true, enrollmentRatePerMonth: 10, treatmentObsMonths: 12, startupCushionMonths: 5,
        // 0.008 = the TTX fixture's own captured single-arm benchmark width (a real emission,
        // not an invented width; the old 0.004 was calibrated to the RCT split-arm geometry).
        isTimeToEvent: false, nullResponseRate: 0.20, comparatorSigma2: 0.008 },
    ];
    const st = computeDevPlan(mixtureFromMssVariance(0.75, 0.08), 0.1, { stages, regulatoryContext: "btd" }, 0).stages[0];
    expect(st.trialSuccessProbRaw).toBeLessThan(0.90);
    expect(st.successCeilingBound ?? null).toBeNull(); // cap idle (dev-plan emits null when unbound)
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

  // RECONCILED with the 2.2 anchored map (§1.6 — the INTENT, "a mis-derived comparator cannot zero a
  // non-degenerate prior", is preserved; the MECHANISM changed from a runtime guard to a structural
  // impossibility). The old guard fired when flooredNull > priorMean — a state only expressible under
  // the ABSOLUTE map, where the comparator and the prior lived on independent scales. On the anchored
  // map the prior is BUILT at (anchor + μ·Δ), so it sits above its comparator by construction; a
  // corrupted 0.80 SOC relocates the comparison, it cannot strand the prior below the bar. The
  // comparatorUnreliable flag is retired (always false) and the threshold is no longer discarded.
  it("a pathological SOC threshold (0.80) above the old prior scale does NOT zero P(success)", () => {
    const bad = computeStageRR(healthyPrior, 300, 0.80, rrDesign, false);
    expect(bad.comparatorUnreliable).toBe(false);                    // retired — structurally impossible
    expect(bad.effectiveNullRR).toBeCloseTo(0.80, 6);                // threshold kept, not discarded
    expect(bad.trialSuccessProb).toBeGreaterThan(0.05);              // NOT a definitional 0
    expect(bad.bandsBefore.belowThreshold).toBeLessThan(0.999);      // not "100% below threshold"
  });

  it("a legitimate low comparator (below the prior mean) is untouched — no flag, no rescue", () => {
    const good = computeStageRR(healthyPrior, 300, 0.12, rrDesign, false);
    expect(good.comparatorUnreliable).toBe(false);
    expect(good.effectiveNullRR).toBeCloseTo(0.12, 6);
  });

  it("a high-but-valid SOC is likewise kept as the threshold (no discard at any level)", () => {
    const strongPrior = mixtureFromMssVariance(0.7, 0.10);
    const r = computeStageRR(strongPrior, 300, 0.55, rrDesign, false);
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
    // §1.6 reconciled: the flag is retired (anchored map — see the stage-level test above); the
    // INTENT stands — a corrupted comparator cannot produce a definitional zero.
    expect(plan.stages[0].comparatorUnreliable).toBe(false);
    expect(plan.stages[0].trialSuccessProb).toBeGreaterThan(0.05);
    expect(plan.pApproval).toBeGreaterThan(0);
  });
});
