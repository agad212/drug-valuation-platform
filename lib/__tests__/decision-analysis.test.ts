import { describe, it, expect } from "vitest";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import { computeRevenuePV } from "../cashflow";
import { buildBaseContext, computeOption, type OptionInputs } from "../decision-analysis";
import type { TrialDesignInputs } from "../ptrs-trial";
import type { Valuation } from "../types";

const baseDesign: TrialDesignInputs = {
  n: 45, endpointType: "surrogate", designType: "single_arm",
  populationType: "biomarker_selected", placeboResponse: "low", regulatoryContext: "orphan",
};

function stage(overrides: Partial<DevStageInput> = {}): DevStageInput {
  return {
    id: "stage-1", name: "Ph2a", phase: "Phase 2", n: 45, cpp: 145000,
    trialDesign: baseDesign, isCurrentTrial: true,
    enrollmentRatePerMonth: 3, treatmentObsMonths: 12, startupCushionMonths: 7,
    ...overrides,
  };
}

describe("decision analysis — Part 2a cost reconciliation", () => {
  it("Option A (baseline) reproduces the dev plan's eNPV, P(approval) and risk-adjusted cost — NOT devCostPV", () => {
    // A valuation whose devCostPV ($500M) is deliberately far larger than the
    // dev plan's bottom-up risk-adjusted cost — the bug that made every advisor
    // option negative. Option A must ignore the $500M and use the engine.
    const v: Valuation = {
      asset: "TESTDRUG", phase: "Phase 2",
      discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
      indications: [{ id: "i1", name: "CRC", peakSales: 320e6, launchYear: 2035, loeYear: 2043, devCostPV: 500e6 }],
    };
    const revenuePV = computeRevenuePV({ ...v, peakSales: 320e6, launchYear: 2035, loeYear: 2043 });
    const out = { ptrs: 0.25, revenuePV, devCostPV: 500e6, rnpv: Math.round(0.25 * revenuePV - 500e6) };

    const mixture = mixtureFromMssVariance(0.55, 0.2);
    const stages = [
      stage(),
      stage({
        id: "stage-2", name: "Ph3", phase: "Phase 3", n: 200, cpp: 280000, isCurrentTrial: false,
        trialDesign: { ...baseDesign, n: 200, designType: "rct", populationType: "broad", regulatoryContext: "standard" },
      }),
    ];
    const devPlan = computeDevPlan(mixture, 0.1, { stages, regulatoryContext: "orphan", regCostM: 1.0 }, revenuePV / 1e6);

    const layer2Result = { trialInputs: baseDesign, ptrsCombined: 0.4 };
    const base = buildBaseContext(v, out, null, layer2Result, null, devPlan);
    expect(base).not.toBeNull();

    const baseline: OptionInputs = { id: "opt-a", name: "Baseline", isBaseline: true };
    const result = computeOption(base!, baseline);

    // The $500M devCostPV must NOT drive the option; the engine's risk-adjusted cost does.
    expect(result.devCostM).toBeCloseTo(devPlan.totalRiskAdjCostM, 1);
    expect(result.devCostM).toBeLessThan(200); // sanity: nowhere near the $500M default
    expect(result.ptrs).toBeCloseTo(devPlan.pApproval, 5);
    // Option A reconciles with the headline Development Path eNPV.
    expect(result.eNPVM).toBeCloseTo(devPlan.eNPVM, 0);
  });
});
