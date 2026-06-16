import { describe, it, expect } from "vitest";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance, normalCDF } from "../effect-prior";
import { computeTrialNoise, type TrialDesignInputs } from "../ptrs-trial";

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

describe("computeDevPlan — Bayesian mixture weight update", () => {
  it("1-component mixture: weight stays at 1 (no-op reweight), matching the old scalar update", () => {
    const mixture = mixtureFromMssVariance(0.5, 0.2); // [{ w: 1, mu: 1.0, sigma2: 0.2 }]
    const plan = computeDevPlan(mixture, 0.1, { stages: [makeStage()], regulatoryContext: "standard" }, 0);

    const stage = plan.stages[0];
    expect(stage.mixtureIfSuccess).toHaveLength(1);
    expect(stage.mixtureIfSuccess[0].w).toBeCloseTo(1, 10);

    // mu' = min(MAX_MU=1.9, mu + 2*uplift_surrogate(0.10)) = min(1.9, 1.0 + 0.2) = 1.2
    expect(stage.mixtureIfSuccess[0].mu).toBeCloseTo(1.2, 10);
    // sigma2' = sigma2 * VARIANCE_REDUCTION(0.65) = 0.2 * 0.65 = 0.13
    expect(stage.mixtureIfSuccess[0].sigma2).toBeCloseTo(0.13, 10);

    // mssIfSuccess/varianceIfSuccess are derived via mixtureMoments — exact
    // for 1-component mixtures.
    expect(stage.mssIfSuccess).toBeCloseTo(0.6, 10);
    expect(stage.varianceIfSuccess).toBeCloseTo(0.13, 10);
  });

  it("2-component mixture: a successful trial reweights toward the higher-success-probability component", () => {
    const mixture = [
      { w: 0.6, mu: 0.5, sigma2: 0.1 }, // weaker-effect story
      { w: 0.4, mu: 1.5, sigma2: 0.1 }, // stronger-effect story
    ];
    const plan = computeDevPlan(mixture, 0.1, { stages: [makeStage()], regulatoryContext: "standard" }, 0);
    const stage = plan.stages[0];

    // Independently compute each component's P(trial success) using the same
    // trial-noise/threshold formula scoreLayer2 uses internally.
    const { sigma2Trial, threshold } = computeTrialNoise(baseTrialDesign);
    const p = mixture.map(({ mu, sigma2 }) => normalCDF((mu - threshold) / Math.sqrt(sigma2 + sigma2Trial)));
    const totalP = mixture[0].w * p[0] + mixture[1].w * p[1];

    // The stronger-effect component (mu=1.5) clears the threshold more easily
    // than the weaker one (mu=0.5), so Bayes' rule shifts weight toward it.
    expect(p[1]).toBeGreaterThan(p[0]);

    const expectedW = mixture.map((c, i) => (c.w * p[i]) / totalP);
    expect(stage.mixtureIfSuccess[0].w).toBeCloseTo(expectedW[0], 10);
    expect(stage.mixtureIfSuccess[1].w).toBeCloseTo(expectedW[1], 10);
    expect(stage.mixtureIfSuccess[0].w + stage.mixtureIfSuccess[1].w).toBeCloseTo(1, 10);

    // Weight shifted FROM the weaker component TOWARD the stronger one.
    expect(stage.mixtureIfSuccess[0].w).toBeLessThan(mixture[0].w);
    expect(stage.mixtureIfSuccess[1].w).toBeGreaterThan(mixture[1].w);

    // Both components still get the same per-component tightening.
    // mu' = min(MAX_MU=1.9, mu + 2*uplift_surrogate(0.10)); sigma2' = sigma2 * 0.65
    expect(stage.mixtureIfSuccess[0].mu).toBeCloseTo(0.7, 10);
    expect(stage.mixtureIfSuccess[1].mu).toBeCloseTo(1.7, 10);
    expect(stage.mixtureIfSuccess[0].sigma2).toBeCloseTo(0.065, 10);
    expect(stage.mixtureIfSuccess[1].sigma2).toBeCloseTo(0.065, 10);
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
