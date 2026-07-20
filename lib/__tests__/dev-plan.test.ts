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
