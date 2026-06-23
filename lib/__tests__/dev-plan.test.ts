import { describe, it, expect } from "vitest";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
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

  it("floors the enrollment rate at 0.1 patients/month to avoid divide-by-zero", () => {
    const mixture = mixtureFromMssVariance(0.5, 0.2);
    const stage = makeStage({ n: 10, enrollmentRatePerMonth: 0, treatmentObsMonths: 6, startupCushionMonths: 3 });
    const plan = computeDevPlan(mixture, 0.1, { stages: [stage], regulatoryContext: "standard" }, 0);

    // enrollmentMonths = n / max(enrollmentRatePerMonth, 0.1) = 10 / 0.1 = 100
    expect(plan.stages[0].enrollmentMonths).toBeCloseTo(100, 10);
    expect(plan.stages[0].durationMonths).toBeCloseTo(109, 10);
  });
});
