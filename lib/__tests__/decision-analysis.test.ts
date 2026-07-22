import { describe, it, expect } from "vitest";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import { computeStageRR, computeStageSuccess } from "../bayesian-rr";
import { computeRevenuePV } from "../cashflow";
import { buildBaseContext, computeOption, programBreadthMultiplier, type OptionInputs } from "../decision-analysis";
import { deriveMarket, deriveEnrichedNiche, nicheIdentityHolds } from "../market-model";
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

// ─── Per-option P(approval) is recomputed from each option's inputs ──────────────
// The bug: every option showed the baseline P(approval) (design changes didn't flow
// into the recompute). These guards prove P now MOVES per option via the SAME engine
// the baseline/what-if use, in the correct direction, and that breadth isn't free.
describe("Strategy Advisor — per-option P(approval) recompute", () => {
  const broadDesign: TrialDesignInputs = {
    n: 200, endpointType: "surrogate", designType: "rct",
    populationType: "broad", placeboResponse: "moderate", regulatoryContext: "standard",
  };
  function mkBase() {
    const v: Valuation = {
      asset: "STRATDRUG", phase: "Phase 2",
      discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
      indications: [{ id: "i1", name: "IPF", peakSales: 1000e6, launchYear: 2032, loeYear: 2044, devCostPV: 300e6 }],
    };
    const revenuePV = computeRevenuePV({ ...v, peakSales: 1000e6, launchYear: 2032, loeYear: 2044 });
    const out = { ptrs: 0.4, revenuePV, devCostPV: 300e6, rnpv: 0 };
    const mixture = mixtureFromMssVariance(0.5, 0.2);
    const stages: DevStageInput[] = [
      stage({ trialDesign: broadDesign, n: 200, nullResponseRate: 0.20 }),
      stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 400, isCurrentTrial: false,
        trialDesign: { ...broadDesign, n: 400 }, nullResponseRate: 0.20 }),
    ];
    const devPlan = computeDevPlan(mixture, 0.1, { stages, regulatoryContext: "standard", regCostM: 1.0 }, revenuePV / 1e6);
    const base = buildBaseContext(v, out, { mss: 0.5, variance: 0.2, ptrs: 0.4 }, { trialInputs: broadDesign }, null, devPlan)!;
    return { base, devPlan, mixture };
  }

  const A: OptionInputs = { id: "opt-a", name: "Baseline", isBaseline: true };

  it("baseline reproduces the headline P(approval) exactly (correctness check)", () => {
    const { base, devPlan } = mkBase();
    expect(computeOption(base, A).ptrs).toBeCloseTo(devPlan.pApproval, 6);
  });

  it("active-comparator option LOWERS P(trial success) vs the placebo/saline baseline", () => {
    const { base } = mkBase();
    const a = computeOption(base, A);
    const active = computeOption(base, { id: "b", name: "Active comparator", comparatorType: "active" }, a);
    expect(active.ptrs).toBeLessThan(a.ptrs - 1e-6); // harder bar → strictly lower
  });

  it("biomarker-selected option RAISES P — and uses the SAME engine path as the what-if", () => {
    const { base, mixture, devPlan } = mkBase();
    const a = computeOption(base, A);
    const bio = computeOption(base, { id: "b", name: "Biomarker", populationType: "biomarker_selected" }, a);
    expect(bio.ptrs).toBeGreaterThan(a.ptrs + 1e-6); // enrichment → strictly higher

    // Shared-code-path proof: the recompute's stage-0 success is the SAME computeStageRR
    // + computeStageSuccess the what-if calls — not a parallel probability model.
    const bioDesign: TrialDesignInputs = { ...broadDesign, populationType: "biomarker_selected" };
    const nullRR = 0.20;
    const grid = computeStageRR(mixture, 200, nullRR, bioDesign, false).priorGrid;
    const whatIfStage0 = computeStageSuccess(grid, 200, nullRR, bioDesign);
    const optionPlanStage0 = computeDevPlan(mixture, 0.1, {
      stages: [
        stage({ trialDesign: bioDesign, n: 200, nullResponseRate: nullRR }),
        stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 400, isCurrentTrial: false,
          trialDesign: { ...broadDesign, n: 400 }, nullResponseRate: nullRR }),
      ],
      regulatoryContext: "standard", regCostM: 1.0,
    }, 0).stages[0].trialSuccessProbRaw;
    expect(optionPlanStage0).toBeCloseTo(whatIfStage0, 9); // identical computation
    void devPlan;
  });

  it("breadth is NOT free: a multi-indication option's blended P is LOWER than the single-indication baseline", () => {
    const { base } = mkBase();
    const a = computeOption(base, A);
    const focused = computeOption(base, { id: "b", name: "Focused expansion (0 added)", addedIndicationCount: 0 }, a);
    const broad2 = computeOption(base, { id: "c", name: "+2 indications", addedIndicationCount: 2 }, a);
    expect(focused.ptrs).toBeCloseTo(a.ptrs, 6);       // 0 added → no penalty
    expect(broad2.ptrs).toBeLessThan(a.ptrs - 1e-6);   // 2 added → strictly lower, never equal/higher
    // ...even when the broad option carries a much larger market (peak): breadth still costs probability.
    const broadBigMarket = computeOption(base, { id: "d", name: "+2 ind, big market", addedIndicationCount: 2, peakSalesMOverride: 5000 }, a);
    expect(broadBigMarket.ptrs).toBeLessThan(a.ptrs - 1e-6);
  });

  it("programBreadthMultiplier is deterministic and only ever ≤ 1", () => {
    expect(programBreadthMultiplier({ id: "x", name: "x" }).mult).toBe(1.0);          // 0 added
    expect(programBreadthMultiplier({ id: "x", name: "x", addedIndicationCount: 1 }).mult).toBeCloseTo(0.80, 6);
    expect(programBreadthMultiplier({ id: "x", name: "x", addedIndicationCount: 2 }).mult).toBeCloseTo(0.64, 6);
    expect(programBreadthMultiplier({ id: "x", name: "x", addedIndicationCount: 1, addedIndicationsValidated: true }).mult).toBeCloseTo(0.92, 6);
  });

  it("the deprecated ptrsOverride does NOT drive P when a dev plan exists (engine governs)", () => {
    const { base, devPlan } = mkBase();
    const a = computeOption(base, A);
    const withOverride = computeOption(base, { id: "b", name: "Bogus override", ptrsOverride: 0.99 }, a);
    expect(withOverride.ptrs).not.toBeCloseTo(0.99, 2);       // override ignored
    expect(withOverride.ptrs).toBeCloseTo(devPlan.pApproval, 6); // same design → same engine P as baseline
  });
});

// ─── Build 1b: GENUINELY BOTTOM-UP niche market (kill the disguised multiplier) ─
describe("Strategy Advisor — bottom-up niche market re-derivation", () => {
  const broadDesign: TrialDesignInputs = {
    n: 200, endpointType: "surrogate", designType: "rct",
    populationType: "broad", placeboResponse: "moderate", regulatoryContext: "standard",
  };
  // Base indication: TAM $4000M × 25% penetration = $1000M peak; WAC $100k/yr → 40,000 eligible.
  function mkMarketBase(peakSalesM = 1000, tamM = 4000) {
    const v: Valuation = {
      asset: "MKTDRUG", phase: "Phase 2",
      discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
      indications: [{ id: "i1", name: "RP", peakSales: peakSalesM * 1e6, tamM, penetrationPct: 25, annualPriceUsd: 100000, launchYear: 2032, loeYear: 2044, devCostPV: 300e6 }],
    };
    const revenuePV = computeRevenuePV({ ...v, peakSales: peakSalesM * 1e6, launchYear: 2032, loeYear: 2044 });
    const out = { ptrs: 0.4, revenuePV, devCostPV: 300e6, rnpv: 0 };
    const mixture = mixtureFromMssVariance(0.5, 0.2);
    const stages: DevStageInput[] = [
      stage({ trialDesign: broadDesign, n: 200, nullResponseRate: 0.20 }),
      stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 400, isCurrentTrial: false, trialDesign: { ...broadDesign, n: 400 }, nullResponseRate: 0.20 }),
    ];
    const devPlan = computeDevPlan(mixture, 0.1, { stages, regulatoryContext: "standard", regCostM: 1.0 }, revenuePV / 1e6);
    const base = buildBaseContext(v, out, { mss: 0.5, variance: 0.2, ptrs: 0.4 }, { trialInputs: broadDesign }, null, devPlan)!;
    return { base };
  }
  const A: OptionInputs = { id: "opt-a", name: "Baseline", isBaseline: true };
  const NICHE: OptionInputs = { id: "b", name: "Niche", nicheEligiblePatients: 20000, nicheAnnualPriceUsd: 200000, nichePeakSharePct: 35 };

  it("base anchor: deriveMarket + calibration + Option A reproduce the base peak", () => {
    expect(deriveMarket({ tamM: 4000, penetrationPct: 25 }).peakSalesM).toBeCloseTo(1000, 6);
    const { base } = mkMarketBase();
    expect(deriveMarket(base.market!).peakSalesM).toBeCloseTo(base.peakSalesM, 6);
    expect(computeOption(base, A).peakSalesM).toBeCloseTo(base.peakSalesM, 6);
  });

  it("niche peak is bottom-up (eligible × price × share) — hand-computed", () => {
    // 20,000 × $200,000/yr = $4000M TAM × 35% = $1400M. No base term enters.
    const n = deriveEnrichedNiche({ nicheEligiblePatients: 20000, nicheAnnualPriceUsd: 200000, nichePeakSharePct: 35 });
    expect(n.tamM).toBeCloseTo(4000, 6);
    expect(n.peakSalesM).toBeCloseTo(1400, 6);
  });

  it("DECOUPLING (load-bearing): niche peak is INVARIANT to the base peak when niche params are fixed", () => {
    // The guard that would have caught Build 1. Same niche absolute params, wildly different base.
    const small = computeOption(mkMarketBase(500, 2000).base, NICHE, undefined);
    const big   = computeOption(mkMarketBase(5000, 20000).base, NICHE, undefined);
    expect(small.peakSalesM).toBeCloseTo(1400, 3);
    expect(big.peakSalesM).toBeCloseTo(1400, 3);
    expect(small.peakSalesM).toBeCloseTo(big.peakSalesM, 6); // independent of base — genuine re-derivation

    // PROOF the old Build-1 implementation FAILS this: base × (prevalence×premium×penMult) scales with base.
    const oldNiche = (basePeak: number) => basePeak * (0.35 * 1.4 * 1.3); // the disguised multiplier
    expect(oldNiche(500)).not.toBeCloseTo(oldNiche(5000), 3); // scales with base → would FAIL decoupling
  });

  it("FALSIFIABLE identity: a consistent niche passes, a tampered one FAILS (the guard can fail)", () => {
    const p = { nicheEligiblePatients: 20000, nicheAnnualPriceUsd: 200000, nichePeakSharePct: 35 };
    const good = deriveEnrichedNiche(p);
    expect(nicheIdentityHolds(good, p)).toBe(true);
    expect(nicheIdentityHolds({ ...good, peakSalesM: good.peakSalesM * 2 }, p)).toBe(false); // tampered peak
    expect(nicheIdentityHolds({ ...good, tamM: good.tamM + 500 }, p)).toBe(false);            // tampered TAM
  });

  it("net is COMPUTED not signed: a strong niche exceeds base, a weak niche falls below", () => {
    const { base } = mkMarketBase(); // base peak 1000
    const strong = computeOption(base, { id: "b", name: "Strong", nicheEligiblePatients: 30000, nicheAnnualPriceUsd: 250000, nichePeakSharePct: 40 }, undefined);
    const weak   = computeOption(base, { id: "c", name: "Weak",   nicheEligiblePatients: 8000,  nicheAnnualPriceUsd: 120000, nichePeakSharePct: 20 }, undefined);
    expect(strong.peakSalesM).toBeGreaterThan(base.peakSalesM); // 30k×250k×40% = $3000M
    expect(weak.peakSalesM).toBeLessThan(base.peakSalesM);      // 8k×120k×20%  = $192M
  });

  it("prevalence-only enrichment derives the COUNT from base eligible, price/share are absolute defaults", () => {
    const { base } = mkMarketBase(); // base eligible = 4000M/$100k = 40,000
    const a = computeOption(base, A);
    // A PURE market change (prevalence only, NO design/population change) → market re-derives,
    // probability is untouched. (A real biomarker option would ALSO set populationType, which
    // legitimately moves P via the design lever — tested separately in the per-option-P block.)
    const bio = computeOption(base, { id: "b", name: "Biomarker market", biomarkerPrevalence: 0.25 }, a);
    // count = 40,000 × 0.25 = 10,000; × $200k default × 35% default = $700M.
    expect(bio.peakSalesM).toBeCloseTo(700, 0);
    expect(bio.ptrs).toBeCloseTo(a.ptrs, 6); // REVENUE-ONLY: pure market change doesn't move P
  });

  it("added indications SUM their own bottom-up markets onto the lead (unchanged from Build 1)", () => {
    const { base } = mkMarketBase();
    const a = computeOption(base, A);
    const multi = computeOption(base, { id: "c", name: "+AMD", addedIndicationMarkets: [{ tamM: 6000, penetrationPct: 18 }] }, a);
    expect(multi.peakSalesM).toBeCloseTo(base.peakSalesM + deriveMarket({ tamM: 6000, penetrationPct: 18 }).peakSalesM, 3);
  });

  it("design change alone still does not haircut peak (no automatic multiplier)", () => {
    const { base } = mkMarketBase();
    const a = computeOption(base, A);
    expect(computeOption(base, { id: "b", name: "Single-arm", designType: "single_arm" }, a).peakSalesM).toBeCloseTo(base.peakSalesM, 6);
  });
});
