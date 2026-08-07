import { describe, it, expect } from "vitest";
import { computeDevPlan, impliedLaunchYear, shiftLoeForLaunch, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import type { TrialDesignInputs } from "../ptrs-trial";

const baseTrialDesign: TrialDesignInputs = {
  n: 100,
  endpointType: "surrogate",
  designType: "rct",
  populationType: "broad",
  placeboResponse: "low",
  regulatoryContext: "standard",
};

function makeStage(overrides: Partial<DevStageInput> = {}): DevStageInput {
  return {
    id: "stage-1",
    name: "Test Stage",
    phase: "Phase 2",
    n: 100,
    cpp: 100000,
    trialDesign: baseTrialDesign,
    isCurrentTrial: true,
    enrollmentRatePerMonth: 5,
    treatmentObsMonths: 9,
    startupCushionMonths: 6,
    ...overrides,
  };
}

describe("computeDevPlan — Bayesian posterior update (response-rate engine)", () => {
  it("1-component mixture: posterior has w=1, mean shifts up, variance shrinks", () => {
    const mixture = mixtureFromMssVariance(0.5, 0.2);
    const plan = computeDevPlan(mixture, 0.1, { stages: [makeStage()], regulatoryContext: "standard" }, 0);

    const stage = plan.stages[0];
    expect(stage.mixtureIfSuccess).toHaveLength(1);
    expect(stage.mixtureIfSuccess[0].w).toBeCloseTo(1, 5);

    // Posterior mean (mu/2 = mss) should shift UP after success
    expect(stage.mssIfSuccess).toBeGreaterThan(stage.mssInput);
    // Posterior variance should SHRINK
    expect(stage.varianceIfSuccess).toBeLessThan(stage.varianceInput);

    // RR diagnostics should be populated
    expect(stage.bandsBefore).toBeDefined();
    expect(stage.bandsAfter).toBeDefined();
    expect(stage.rrPriorGrid).toBeDefined();
    expect(stage.rrPosteriorGrid).toBeDefined();
    expect(stage.nullResponseRate).toBeGreaterThan(0);
  });

  it("2-component mixture: posterior mean shifts up, strong component favored", () => {
    const mixture = [
      { w: 0.6, mu: 0.5, sigma2: 0.1 },
      { w: 0.4, mu: 1.5, sigma2: 0.1 },
    ];
    const plan = computeDevPlan(mixture, 0.1, { stages: [makeStage()], regulatoryContext: "standard" }, 0);
    const stage = plan.stages[0];

    // The posterior should have mssIfSuccess > mssInput (success shifts up)
    expect(stage.mssIfSuccess).toBeGreaterThan(stage.mssInput);

    // Band masses after success: less mass below threshold, more in strong
    expect(stage.bandsAfter!.belowThreshold).toBeLessThan(stage.bandsBefore!.belowThreshold);
    expect(stage.bandsAfter!.strong).toBeGreaterThan(stage.bandsBefore!.strong);

    // Counterfactuals should be generated
    expect(stage.counterfactuals).toBeDefined();
    expect(stage.counterfactuals!.length).toBeGreaterThan(0);
  });
});

describe("computeDevPlan — trial duration economics", () => {
  it("derives enrollmentMonths, durationMonths, and totalDurationMonths from per-stage rates", () => {
    const mixture = mixtureFromMssVariance(0.5, 0.2);
    const stage = makeStage({ n: 100, enrollmentRatePerMonth: 5, treatmentObsMonths: 9, startupCushionMonths: 6 });
    const plan = computeDevPlan(mixture, 0.1, { stages: [stage], regulatoryContext: "standard" }, 0);

    // enrollmentMonths = n / enrollmentRatePerMonth = 100 / 5 = 20
    expect(plan.stages[0].enrollmentMonths).toBeCloseTo(20, 10);
    // durationMonths = enrollmentMonths + treatmentObsMonths + startupCushionMonths = 20 + 9 + 6 = 35
    expect(plan.stages[0].durationMonths).toBeCloseTo(35, 10);
    // totalDurationMonths = sum(durationMonths) + regStage.reviewMonths (standard = 12)
    expect(plan.regStage.reviewMonths).toBe(12);
    expect(plan.totalDurationMonths).toBeCloseTo(47, 10);
  });

  it("floors the enrollment rate (no divide-by-zero) then clamps the result to a credible ceiling", () => {
    const mixture = mixtureFromMssVariance(0.5, 0.2);
    const stage = makeStage({ n: 10, enrollmentRatePerMonth: 0, treatmentObsMonths: 6, startupCushionMonths: 3 });
    const plan = computeDevPlan(mixture, 0.1, { stages: [stage], regulatoryContext: "standard" }, 0);

    // rate 0 → floored to 0.1 → raw accrual = 10 / 0.1 = 100 mo (finite, not Infinity/NaN),
    // then clamped to the Phase-2 enrollment ceiling (36 mo) so a bad rate can't inflate the timeline.
    expect(plan.stages[0].enrollmentMonthsRaw).toBeCloseTo(100, 10);
    expect(plan.stages[0].enrollmentClamped).toBe(true);
    expect(plan.stages[0].enrollmentMonths).toBe(36);
    expect(Number.isFinite(plan.stages[0].durationMonths)).toBe(true);
    expect(plan.stages[0].durationMonths).toBeCloseTo(36 + 6 + 3, 10);
  });
});

describe("impliedLaunchYear — timeline drives launch year", () => {
  it("adds duration months to the as-of date and returns the calendar year", () => {
    // 2026-07 + 47 months = 2030-06
    expect(impliedLaunchYear(47, new Date(2026, 6, 7))).toBe(2030);
    // 2026-11 + 2 months crosses the year boundary
    expect(impliedLaunchYear(2, new Date(2026, 10, 15))).toBe(2027);
    // zero duration = launch this year
    expect(impliedLaunchYear(0, new Date(2026, 6, 7))).toBe(2026);
  });

  it("rounds fractional months", () => {
    // 2026-01 + round(11.6) = 12 months → 2027-01
    expect(impliedLaunchYear(11.6, new Date(2026, 0, 15))).toBe(2027);
    // 2026-01 + round(11.4) = 11 months → 2026-12
    expect(impliedLaunchYear(11.4, new Date(2026, 0, 15))).toBe(2026);
  });

  it("computeDevPlan carries impliedLaunchYear consistent with totalDurationMonths", () => {
    const mixture = mixtureFromMssVariance(0.5, 0.2);
    const plan = computeDevPlan(mixture, 0.1, { stages: [makeStage()], regulatoryContext: "standard" }, 0);
    expect(plan.impliedLaunchYear).toBe(impliedLaunchYear(plan.totalDurationMonths));
  });
});

describe("shiftLoeForLaunch — LOE response to a moved launch year", () => {
  it("exclusivity-based LOE slides with launch (anchored to approval)", () => {
    expect(shiftLoeForLaunch(2036, "exclusivity", 2032, 8)).toBe(2040);
    expect(shiftLoeForLaunch(2040, "exclusivity", 2031, 12)).toBe(2043);
  });

  it("patent-based LOE stays calendar-fixed when launch is still before it", () => {
    expect(shiftLoeForLaunch(2036, "patent", 2030, 8)).toBe(2036);
    // manual entry (no basis) is also left alone
    expect(shiftLoeForLaunch(2036, undefined, 2030, 8)).toBe(2036);
  });

  it("launch reaching or passing LOE resets it to launch + exclusivity, regardless of basis", () => {
    expect(shiftLoeForLaunch(2030, "patent", 2032, 8)).toBe(2040);
    expect(shiftLoeForLaunch(2030, "patent", 2030, 8)).toBe(2038); // same-year counts
    expect(shiftLoeForLaunch(2030, undefined, 2031, 12)).toBe(2043);
  });

  it("missing LOE passes through untouched", () => {
    expect(shiftLoeForLaunch(undefined, "patent", 2032, 8)).toBeUndefined();
  });
});

// ─── Sourced-margin UNIT GATE (the 8/7 live finding: an effect size wearing rate clothing) ────────
// The margin scale is the most P-moving input a stage carries. The gate requires the basis to SAY
// it is a proportion of patients — "67% slowing of FVC decline" (a % improvement) must never set it.

describe("computeDevPlan — expectedResponseRate unit gate (resolve-or-flag)", () => {
  const mixture = mixtureFromMssVariance(0.5, 0.05); // μ = 1.0 exactly

  it("responder-language basis FIRES the sourced margin: Δ_stage re-derived, flag names the rate + basis", () => {
    const plan = computeDevPlan(mixture, 0.1, {
      stages: [makeStage({ expectedResponseRate: 0.64, expectedResponseRateBasis: "64% of patients achieved ctDNA clearance in the drug's own Phase 1 readout (NCT-X)" })],
      regulatoryContext: "standard",
    }, 0);
    const st = plan.stages[0];
    expect(st.deltaStageSourced).toBe(true);
    // anchor = max(DEFAULT_NULL_RR Phase 2 = 0.15, floor 0.10) = 0.15; μ̄ = 1.0 → Δ = 0.49
    expect(st.deltaStageRR).toBeCloseTo(0.49, 6);
    expect(st.riskFlags.some((f) => /margin scale SOURCED/.test(f.message) && /64%/.test(f.message) && /of patients/i.test(f.message))).toBe(true);
  });

  it("effect-size language is REJECTED: '67% slowing of FVC decline' is a % improvement, not a rate", () => {
    const plan = computeDevPlan(mixture, 0.1, {
      stages: [makeStage({ expectedResponseRate: 0.67, expectedResponseRateBasis: "67% slowing of FVC decline vs historical control in the Phase 2a" })],
      regulatoryContext: "standard",
    }, 0);
    const st = plan.stages[0];
    expect(st.deltaStageSourced).toBe(false);
    expect(st.deltaStageRR).toBeCloseTo(0.10, 9);
    expect(st.riskFlags.some((f) => /REJECTED/.test(f.message) && /not a response rate/i.test(f.message))).toBe(true);
    // And the rejected rate must produce the SAME probability as never emitting it (identical claim size)
    const clean = computeDevPlan(mixture, 0.1, { stages: [makeStage()], regulatoryContext: "standard" }, 0);
    expect(st.trialSuccessProbRaw).toBeCloseTo(clean.stages[0].trialSuccessProbRaw, 12);
  });

  it("no basis at all → UNSOURCED flag, default margin (unchanged contract)", () => {
    const plan = computeDevPlan(mixture, 0.1, {
      stages: [makeStage({ expectedResponseRate: 0.5 })],
      regulatoryContext: "standard",
    }, 0);
    expect(plan.stages[0].deltaStageSourced).toBe(false);
    expect(plan.stages[0].riskFlags.some((f) => /UNSOURCED/.test(f.message))).toBe(true);
  });
});

// ─── Indication replication-risk component (the IPF trap: positive Phase 2 → failed Phase 3) ─────
// A discrete "the signal doesn't reproduce" hypothesis that symmetric variance cannot represent.
// Citation-gated, band-capped, applied ONCE to the initial prior, self-retiring via Bayes.

describe("computeDevPlan — replicationRisk failure-mass component", () => {
  const mixture = mixtureFromMssVariance(0.6, 0.05);
  const twoStages = () => [
    makeStage({ id: "s1", phase: "Phase 2" }),
    makeStage({ id: "s2", phase: "Phase 3", isCurrentTrial: false, n: 280 }),
  ];
  const basis = "IPF record: nintedanib replicated; pamrevlumab, zinpentraxin, ziritaxestat, IFN-γ failed Phase 3 after positive Phase 2 — ~1-2 of 6 replicated";

  it("a CITED pFail carves real failure mass out of the prior: stage-0 raw P drops, weight echoed, flag names the record", () => {
    const clean = computeDevPlan(mixture, 0.1, { stages: twoStages(), regulatoryContext: "standard" }, 0);
    const risky = computeDevPlan(mixture, 0.1, {
      stages: twoStages(), regulatoryContext: "standard",
      replicationRisk: { pFail: 0.5, basis },
    }, 0);
    expect(risky.replicationWeightApplied).toBe(0.5);
    expect(risky.stages[0].trialSuccessProbRaw).toBeLessThan(clean.stages[0].trialSuccessProbRaw);
    // The carve-out is roughly proportional at stage 0: a 50% failure component leaves at most
    // ~(0.5 × clean + 0.5 × noise-level success) — assert the drop is material, not cosmetic.
    expect(risky.stages[0].trialSuccessProbRaw).toBeLessThan(0.62 * clean.stages[0].trialSuccessProbRaw + 0.05);
    expect(risky.pApproval).toBeLessThan(clean.pApproval);
    expect(risky.stages[0].riskFlags.some((f) => /indication replication risk: 50%/.test(f.message) && /nintedanib/.test(f.message))).toBe(true);
  });

  it("SELF-RETIRES via Bayes: the stage-1 hit is proportionally smaller than the stage-0 hit (a survived success shrinks the failure weight)", () => {
    const clean = computeDevPlan(mixture, 0.1, { stages: twoStages(), regulatoryContext: "standard" }, 0);
    const risky = computeDevPlan(mixture, 0.1, {
      stages: twoStages(), regulatoryContext: "standard",
      replicationRisk: { pFail: 0.6, basis },
    }, 0);
    const hit0 = risky.stages[0].trialSuccessProbRaw / clean.stages[0].trialSuccessProbRaw;
    const hit1 = risky.stages[1].trialSuccessProbRaw / clean.stages[1].trialSuccessProbRaw;
    expect(hit0).toBeLessThan(1);
    expect(hit1).toBeGreaterThan(hit0); // conditioning on stage-0 success already paid most of the toll
  });

  it("UNCITED → ignored + flagged; probabilities identical to no-claim", () => {
    const clean = computeDevPlan(mixture, 0.1, { stages: twoStages(), regulatoryContext: "standard" }, 0);
    const uncited = computeDevPlan(mixture, 0.1, {
      stages: twoStages(), regulatoryContext: "standard",
      replicationRisk: { pFail: 0.5, basis: "   " },
    }, 0);
    expect(uncited.pApproval).toBeCloseTo(clean.pApproval, 12);
    expect(uncited.replicationWeightApplied ?? null).toBeNull();
    expect(uncited.stages[0].riskFlags.some((f) => /UNCITED/.test(f.message) && /replicationRisk/.test(f.message))).toBe(true);
  });

  it("band edges: 0.95 clamps DOWN to the 0.80 cap (shown); 0.01 is IGNORED, never raised to the floor", () => {
    const capped = computeDevPlan(mixture, 0.1, {
      stages: twoStages(), regulatoryContext: "standard",
      replicationRisk: { pFail: 0.95, basis },
    }, 0);
    expect(capped.replicationWeightApplied).toBe(0.8);
    expect(capped.stages[0].riskFlags.some((f) => /CLAMPED to the 80% cap/.test(f.message))).toBe(true);

    const noise = computeDevPlan(mixture, 0.1, {
      stages: twoStages(), regulatoryContext: "standard",
      replicationRisk: { pFail: 0.01, basis },
    }, 0);
    const clean = computeDevPlan(mixture, 0.1, { stages: twoStages(), regulatoryContext: "standard" }, 0);
    expect(noise.pApproval).toBeCloseTo(clean.pApproval, 12);
    expect(noise.stages[0].riskFlags.some((f) => /below the 5% noise floor/.test(f.message))).toBe(true);
  });

  it("failure mass must NOT inflate a sourced margin: Δ_stage is conditional on effect (same with or without the component)", () => {
    // Caught pre-live 8/7: dividing the sourced margin by the UNCONDITIONAL μ̄ made the success
    // branch overshoot the cited rate (48% cited → ~70% implied at w=0.40). The sourced rate
    // describes the drug WHEN IT WORKS; the failure hypothesis lives in the weights, not the scale.
    const sourcedStage = () => [
      makeStage({ expectedResponseRate: 0.48, expectedResponseRateBasis: "48% of patients achieved FVC preservation (ENV-IPF-101)" }),
    ];
    const clean = computeDevPlan(mixture, 0.1, { stages: sourcedStage(), regulatoryContext: "standard" }, 0);
    const risky = computeDevPlan(mixture, 0.1, {
      stages: sourcedStage(), regulatoryContext: "standard",
      replicationRisk: { pFail: 0.4, basis },
    }, 0);
    expect(risky.stages[0].deltaStageRR).toBeCloseTo(clean.stages[0].deltaStageRR, 9);
    // And the component still bites: probability drops even though the scale is unchanged.
    expect(risky.stages[0].trialSuccessProbRaw).toBeLessThan(clean.stages[0].trialSuccessProbRaw);
  });

  it("CAPABILITY GATE: absent field → bit-for-bit legacy (FROZEN-safe by construction)", () => {
    const a = computeDevPlan(mixture, 0.1, { stages: twoStages(), regulatoryContext: "standard" }, 0);
    const b = computeDevPlan(mixture, 0.1, { stages: twoStages(), regulatoryContext: "standard", replicationRisk: undefined }, 0);
    expect(b.pApproval).toBe(a.pApproval);
    expect(b.stages[0].trialSuccessProbRaw).toBe(a.stages[0].trialSuccessProbRaw);
  });
});
