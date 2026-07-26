import { describe, it, expect } from "vitest";
import { computeDevPlan, deriveRegConfidence, resolveRegAcceptanceLevel, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import { computeStageRR, computeStageSuccess } from "../bayesian-rr";
import { computeRevenuePV } from "../cashflow";
import { buildBaseContext, computeOption, programBreadthMultiplier, isBiomarkerEnriched, type OptionInputs } from "../decision-analysis";
import { deriveMarket, deriveEnrichedNiche, nicheIdentityHolds } from "../market-model";
import { enrichEffectPrior, resolveEnrichmentLift, mixtureMoments, DEFAULT_ENRICHMENT_LIFT, MAX_ENRICHMENT_LIFT } from "../effect-prior";
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

  it("biomarker enrichment (SOURCED prevalence): option-stage P == enriched what-if; non-vacuous; non-propagating", () => {
    const { base, mixture } = mkBase();
    const a = computeOption(base, A);
    // Option carries a SOURCED prevalence → computeDevPlan enriches stage-0 per-stage.
    const bio = computeOption(base, { id: "b", name: "Biomarker", populationType: "biomarker_selected", biomarkerPrevalence: 0.3 }, a);
    expect(bio.ptrs).toBeGreaterThan(a.ptrs + 1e-6);                       // enrichment → strictly higher

    const nullRR = 0.20;
    const bioDesign: TrialDesignInputs = { ...broadDesign, populationType: "biomarker_selected", biomarkerPrevalence: 0.3 };
    const lift = resolveEnrichmentLift({ prevalence: 0.3 }).lift;          // the SAME shared resolver the engine uses
    // What-if = enrich the prior, then run the SAME stage-success integral (Build-2 equivalence,
    // on the ENRICHED path — not a bare stage that would hold at 0 and test nothing).
    const enrichedGrid = computeStageRR(enrichEffectPrior(mixture, lift), 200, nullRR, bioDesign, false).priorGrid;
    const whatIfStage0 = computeStageSuccess(enrichedGrid, 200, nullRR, bioDesign);
    const plan = computeDevPlan(mixture, 0.1, {
      stages: [
        stage({ trialDesign: bioDesign, n: 200, nullResponseRate: nullRR }),
        stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 400, isCurrentTrial: false,
          trialDesign: { ...broadDesign, n: 400 }, nullResponseRate: nullRR }),
      ],
      regulatoryContext: "standard", regCostM: 1.0,
    }, 0);
    expect(plan.stages[0].trialSuccessProbRaw).toBeCloseTo(whatIfStage0, 9); // option stage-0 == enriched what-if

    // NON-VACUOUS: enriched stage-0 is strictly ABOVE the un-enriched — FAILS if enrichment stops.
    const bareGrid = computeStageRR(mixture, 200, nullRR, bioDesign, false).priorGrid;
    const unenriched = computeStageSuccess(bareGrid, 200, nullRR, bioDesign);
    expect(plan.stages[0].trialSuccessProbRaw).toBeGreaterThan(unenriched + 1e-3);

    // NON-PROPAGATION: the broad Ph3 stage is UNAFFECTED by the Ph2 enrichment (confined per-stage).
    // Its s1 equals the s1 of an identical plan whose Ph2 was never enriched — FAILS if the
    // concentrated belief propagates forward.
    const planNoEnrich = computeDevPlan(mixture, 0.1, {
      stages: [
        stage({ trialDesign: { ...broadDesign }, n: 200, nullResponseRate: nullRR }),
        stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 400, isCurrentTrial: false,
          trialDesign: { ...broadDesign, n: 400 }, nullResponseRate: nullRR }),
      ],
      regulatoryContext: "standard", regCostM: 1.0,
    }, 0);
    expect(plan.stages[1].trialSuccessProb).toBeCloseTo(planNoEnrich.stages[1].trialSuccessProb, 9);
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
    // biomarkerPrevalence is a canonical enrichment signal → it re-derives the MARKET count
    // AND (Build 2) shifts the effect prior, so ONE signal moves both axes (the unification).
    const bio = computeOption(base, { id: "b", name: "Biomarker", biomarkerPrevalence: 0.25 }, a);
    // count = 40,000 × 0.25 = 10,000; × $200k default × 35% default = $700M.
    expect(bio.peakSalesM).toBeCloseTo(700, 0);   // market re-derived (unchanged from Build 1b)
    expect(bio.ptrs).toBeGreaterThan(a.ptrs);      // Build 2: same signal also lifts P via the shifted prior
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

// ─── Build 2: biomarker enrichment shifts the effect PRIOR upstream (not frozen, not ×P) ─
describe("Strategy Advisor — biomarker enrichment shifts the effect prior", () => {
  const broadDesign: TrialDesignInputs = {
    n: 200, endpointType: "surrogate", designType: "rct",
    populationType: "broad", placeboResponse: "moderate", regulatoryContext: "standard",
  };
  const rr = { designType: "rct" as const, endpointType: "surrogate" as const, populationType: "broad" as const, regulatoryContext: "standard" as const, n: 200 };
  function mkBase(mss = 0.5, variance = 0.2) {
    const v: Valuation = {
      asset: "ENRDRUG", phase: "Phase 2", discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
      // market components so the market re-derivation has a base eligible count (tamM/$price)
      indications: [{ id: "i1", name: "IPF", peakSales: 1000e6, tamM: 4000, penetrationPct: 25, annualPriceUsd: 100000, launchYear: 2032, loeYear: 2044, devCostPV: 300e6 }],
    };
    const revenuePV = computeRevenuePV({ ...v, peakSales: 1000e6, launchYear: 2032, loeYear: 2044 });
    const out = { ptrs: 0.4, revenuePV, devCostPV: 300e6, rnpv: 0 };
    const stages: DevStageInput[] = [
      stage({ trialDesign: broadDesign, n: 200, nullResponseRate: 0.20 }),
      stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 400, isCurrentTrial: false, trialDesign: { ...broadDesign, n: 400 }, nullResponseRate: 0.20 }),
    ];
    const devPlan = computeDevPlan(mixtureFromMssVariance(mss, variance), 0.1, { stages, regulatoryContext: "standard", regCostM: 1.0 }, revenuePV / 1e6);
    const base = buildBaseContext(v, out, { mss, variance, ptrs: 0.4 }, { trialInputs: broadDesign }, null, devPlan)!;
    return { base, stages, revenuePVM: revenuePV / 1e6 };
  }
  const A: OptionInputs = { id: "opt-a", name: "Baseline", isBaseline: true };

  it("enrichEffectPrior MOVES the truth curve (μ↑, σ² tighter); f≤0 is a no-op", () => {
    const m = mixtureFromMssVariance(0.4, 0.2); // μ 0.80, σ² 0.20
    const before = mixtureMoments(m);
    const after = mixtureMoments(enrichEffectPrior(m, 0.3));
    // eslint-disable-next-line no-console
    console.log(`[BUILD2] prior shift: μ ${(before.mss * 2).toFixed(3)}→${(after.mss * 2).toFixed(3)}, σ² ${before.variance.toFixed(3)}→${after.variance.toFixed(3)}`);
    expect(after.mss * 2).toBeGreaterThan(before.mss * 2);   // μ rises (responder concentration)
    expect(after.variance).toBeLessThan(before.variance);     // σ² tightens (less heterogeneity)
    expect(enrichEffectPrior(m, 0)).toEqual(m);               // f=0 → unchanged (baseline)
    expect(enrichEffectPrior(m, -1)).toEqual(m);              // f<0 → unchanged
  });

  it("GROUNDED + BOUNDED: a huge factor is capped at MAX (μ can't blow up)", () => {
    const m = mixtureFromMssVariance(0.5, 0.2);
    expect(mixtureMoments(enrichEffectPrior(m, 999)).mss).toBeCloseTo(mixtureMoments(enrichEffectPrior(m, MAX_ENRICHMENT_LIFT)).mss, 9);
  });

  it("SANITY: enrichment alone cannot carry a weak/graveyard-class prior to ~99%", () => {
    const weak = mixtureFromMssVariance(0.31, 0.13); // tau-like, low μ
    const p = computeStageRR(enrichEffectPrior(weak, 999), 200, 0.20, rr).trialSuccessProb;
    expect(p).toBeLessThan(0.90); // ceiling/bound hold — nowhere near 0.99
  });

  it("CONSISTENCY: the what-if biomarker branch IS enrichEffectPrior over the same prior (shared machinery)", () => {
    const m = mixtureFromMssVariance(0.45, 0.15);
    const r = computeStageRR(m, 200, 0.20, rr);
    const whatIf = r.counterfactuals.find((c) => /biomarker-selected/i.test(c.label))!.pSuccess;
    // Independently: enrich the prior, then run the SAME stage-success integral.
    const enrichedGrid = computeStageRR(enrichEffectPrior(m, DEFAULT_ENRICHMENT_LIFT), 200, 0.20, rr).priorGrid;
    const manual = computeStageSuccess(enrichedGrid, 200, r.effectiveNullRR, rr);
    expect(whatIf).toBeCloseTo(manual, 9);                 // what-if == enriched-prior stage success
    expect(whatIf).toBeGreaterThan(r.trialSuccessProb);    // and higher than the un-enriched base
  });

  it("OPTION: biomarker enrichment raises P off baseline (the 61% fix); f=0 → baseline; ONE predicate unifies", () => {
    const { base } = mkBase();
    const a = computeOption(base, A);
    const enriched = computeOption(base, { id: "b", name: "Biomarker", populationType: "biomarker_selected" }, a);
    expect(enriched.ptrs).toBeGreaterThan(a.ptrs + 1e-6);  // P moved via the shifted prior — no longer frozen
    // f=0 (no concentration rationale) → baseline P (zeroable)
    const noLift = computeOption(base, { id: "c", name: "No-lift", populationType: "biomarker_selected", enrichmentEffectLift: 0 }, a);
    expect(noLift.ptrs).toBeCloseTo(a.ptrs, 6);
    // predicate = BIOMARKER-SPECIFIC only: populationType / biomarkerPrevalence<1 / explicit lift.
    // Generic tightness and broadening are NOT enrichment (must not lift μ).
    expect(isBiomarkerEnriched({ id: "x", name: "x", populationType: "biomarker_selected" })).toBe(true);
    expect(isBiomarkerEnriched({ id: "x", name: "x", biomarkerPrevalence: 0.3 })).toBe(true);
    expect(isBiomarkerEnriched({ id: "x", name: "x", inclusionCriteria: "tight" })).toBe(false); // generic narrowing ≠ biomarker
    expect(isBiomarkerEnriched({ id: "x", name: "x", populationType: "broad" })).toBe(false);
  });

  it("PATCH: generic tight narrowing moves the MARKET but NOT P (no free effect lift)", () => {
    const { base } = mkBase();
    const a = computeOption(base, A);
    // inclusionCriteria:"tight" with NO biomarker signal → severity/line/age/geography narrowing.
    const tight = computeOption(base, { id: "b", name: "Tight (severity)", inclusionCriteria: "tight" }, a);
    expect(tight.ptrs).toBeCloseTo(a.ptrs, 6);                        // P (μ) UNCHANGED — the bug fix
    expect(tight.peakSalesM).not.toBeCloseTo(base.peakSalesM, 1);     // market (count) still re-derives
    // Contrast: a real biomarker option DOES lift P.
    const bio = computeOption(base, { id: "c", name: "Biomarker", populationType: "biomarker_selected" }, a);
    expect(bio.ptrs).toBeGreaterThan(a.ptrs + 1e-6);
  });

  it("PATCH: enrichment lift is SIZED by responder prevalence (0.10 ≠ 0.90, not a flat +0.30)", () => {
    const { base } = mkBase();
    const rare = computeOption(base, { id: "b", name: "Rare responders", biomarkerPrevalence: 0.10 }, undefined);
    const common = computeOption(base, { id: "c", name: "Common responders", biomarkerPrevalence: 0.90 }, undefined);
    // A rarer responder subset concentrates the effect MORE → larger lift → higher P.
    expect(rare.ptrs).toBeGreaterThan(common.ptrs + 1e-6);
    // And the μ shift itself differs (bounded): 0.10 hits the MAX cap, 0.90 is well below DEFAULT.
    const m = mixtureFromMssVariance(0.5, 0.2);
    const fRare = Math.min(MAX_ENRICHMENT_LIFT, DEFAULT_ENRICHMENT_LIFT * (0.35 / 0.10));   // capped 0.60
    const fCommon = DEFAULT_ENRICHMENT_LIFT * (0.35 / 0.90);                                 // ≈0.117
    expect(mixtureMoments(enrichEffectPrior(m, fRare)).mss).toBeGreaterThan(mixtureMoments(enrichEffectPrior(m, fCommon)).mss);
  });

  it("NO DOUBLE-COUNT: enrichment shifts the prior ONLY — it does not also flip POP_N_FACTOR", () => {
    const { base, stages, revenuePVM } = mkBase();
    const a = computeOption(base, A);
    const enriched = computeOption(base, { id: "b", name: "Biomarker", populationType: "biomarker_selected" }, a);
    // Reconstruct the recompute the option SHOULD do: enriched prior + BASE (broad) design
    // stages (no POP_N_FACTOR flip). If the option also flipped POP_N_FACTOR, it would be higher.
    const manual = computeDevPlan(
      enrichEffectPrior(mixtureFromMssVariance(0.5, 0.2), DEFAULT_ENRICHMENT_LIFT),
      0.1, { stages, regulatoryContext: "standard", regCostM: 1.0 }, revenuePVM,
    );
    expect(enriched.ptrs).toBeCloseTo(manual.pApproval, 6); // prior-shift only; broad design retained
    expect(enriched.ptrs).toBeGreaterThan(a.ptrs);          // still higher than baseline
  });
});

// ─── Regulatory confidence — evidence-derived, graded, UNIFIED (base re-pin) ────────
describe("Regulatory confidence — evidence-derived graded scale (unified base + scenario)", () => {
  const design = (o: Partial<TrialDesignInputs> = {}): TrialDesignInputs => ({
    n: 200, endpointType: "surrogate", designType: "rct", populationType: "broad",
    placeboResponse: "low", regulatoryContext: "standard", ...o,
  });
  const regStages = (): DevStageInput[] => [
    stage({ trialDesign: design(), n: 200, nullResponseRate: 0.20 }),
    stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 400, isCurrentTrial: false, trialDesign: design({ n: 400 }), nullResponseRate: 0.20 }),
  ];
  const plan = (regEndpoint?: any) =>
    computeDevPlan(mixtureFromMssVariance(0.5, 0.2), 0.1,
      { stages: regStages(), regulatoryContext: "standard", regCostM: 1.0, ...(regEndpoint ? { regEndpoint } : {}) }, 1000);

  it("deriveRegConfidence graded rungs: L1 hard 0.88 > L2 validated 0.85 ≥ held 0.85 > L3 accel 0.79 > L4 no-precedent 0.73; bounded", () => {
    expect(deriveRegConfidence({ designation: "standard", endpointType: "hard" })).toBeCloseTo(0.88, 6);                                          // L1 precedented outcome (+0.03)
    expect(deriveRegConfidence({ designation: "standard", endpointType: "surrogate", endpointEvidenceBasis: "CONFIRMED" })).toBeCloseTo(0.85, 6); // L2 validated (0)
    // INFERRED with NO observables → HELD at base rate (0.85), FLAGGED — NOT the old −0.12 L4.
    expect(deriveRegConfidence({ designation: "standard", endpointType: "surrogate", endpointEvidenceBasis: "INFERRED" })).toBeCloseTo(0.85, 6); // held (absence ≠ penalty)
    expect(deriveRegConfidence({ designation: "standard", endpointType: "surrogate", regAcceptance: { endpointType: "surrogate", acceleratedOnlyPrecedent: true } })).toBeCloseTo(0.79, 6);      // L3 (−0.06)
    expect(deriveRegConfidence({ designation: "standard", endpointType: "surrogate", regAcceptance: { endpointType: "surrogate", priorFullApprovalsOnEndpoint: "none" } })).toBeCloseTo(0.73, 6); // L4 positive-no-precedent (−0.12)
    expect(deriveRegConfidence({ designation: "btd", endpointType: "surrogate", endpointEvidenceBasis: "CONFIRMED" })).toBeCloseTo(0.92, 6);      // designation base flows through
    expect(deriveRegConfidence({ designation: "confirmatory", endpointType: "hard" })).toBeCloseTo(0.97, 6);                                      // 0.95+0.03 → capped at 0.97
  });

  it("reg gate is UNIFIED: base (no regEndpoint) holds at base rate; positive evidence resolves the graded scale", () => {
    expect(plan().regStage.pApproval).toBeCloseTo(0.85, 6);                                                                    // base: last-stage surrogate, no observables → HELD at base rate
    expect(plan({ endpointType: "surrogate", priorFullApprovalsOnEndpoint: "none" }).regStage.pApproval).toBeCloseTo(0.73, 6); // L4 positive no-precedent
    expect(plan({ endpointType: "surrogate", acceleratedOnlyPrecedent: true }).regStage.pApproval).toBeCloseTo(0.79, 6);       // L3
    expect(plan({ endpointType: "hard" }).regStage.pApproval).toBeCloseTo(0.88, 6);                                            // L1
  });

  it("reg MOVES on POSITIVE evidence, ORTHOGONAL to trial P; unconfirmed HOLDS (no penalty)", () => {
    const held = plan(), noPrec = plan({ endpointType: "surrogate", priorFullApprovalsOnEndpoint: "none" }), hard = plan({ endpointType: "hard" });
    const inferred = plan({ endpointType: "surrogate", endpointEvidenceBasis: "INFERRED" });
    // eslint-disable-next-line no-console
    console.log(`[REPIN] reg P: held ${held.regStage.pApproval} | no-precedent ${noPrec.regStage.pApproval} | hard ${hard.regStage.pApproval} | INFERRED-held ${inferred.regStage.pApproval}`);
    expect(noPrec.regStage.pApproval).toBeLessThan(held.regStage.pApproval);        // positive no-precedent → down (L4)
    expect(hard.regStage.pApproval).toBeGreaterThan(held.regStage.pApproval);        // hard → up (L1)
    expect(inferred.regStage.pApproval).toBeCloseTo(held.regStage.pApproval, 9);     // unconfirmed → HELD, no penalty (absence of evidence ≠ verdict)
    // Endpoint acceptability moves reg only, NEVER trial P (both stages byte-identical across all reg variants).
    for (const p of [noPrec, hard, inferred]) {
      expect(p.stages[0].trialSuccessProb).toBeCloseTo(held.stages[0].trialSuccessProb, 12);
      expect(p.stages[1].trialSuccessProb).toBeCloseTo(held.stages[1].trialSuccessProb, 12);
    }
  });

  it("SANITY: reg confidence alone can't carry a weak-evidence asset to a high P", () => {
    const weak = computeDevPlan(
      mixtureFromMssVariance(0.30, 0.13), 0.1,
      { stages: [stage({ trialDesign: design({ regulatoryContext: "confirmatory" }), n: 40, nullResponseRate: 0.45 })], regulatoryContext: "confirmatory", regCostM: 1.0, regEndpoint: { endpointType: "hard" } },
      1000,
    );
    expect(weak.regStage.pApproval).toBeLessThanOrEqual(0.97);  // bounded (cap holds)
    expect(weak.pApproval).toBeLessThan(0.60);                  // pAllTrials gated by ceilings → best reg can't rescue it
  });

  it("OPTION path wires it via the SAME deriveRegConfidence (option == what-if); unconfirmed HOLDS", () => {
    // Base registration endpoint = surrogate, no observables → HELD at base rate (0.85). An
    // option that asserts POSITIVE no-precedent evidence resolves L4 (0.73) → changes ONLY reg
    // (not a trial-P input), so the option's P scales by exactly the reg ratio 0.73/0.85.
    const v: Valuation = {
      asset: "REGDRUG", phase: "Phase 2", discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
      indications: [{ id: "i1", name: "X", peakSales: 1000e6, launchYear: 2032, loeYear: 2044, devCostPV: 300e6 }],
    };
    const revenuePV = computeRevenuePV({ ...v, peakSales: 1000e6, launchYear: 2032, loeYear: 2044 });
    const out = { ptrs: 0.4, revenuePV, devCostPV: 300e6, rnpv: 0 };
    const devPlan = computeDevPlan(mixtureFromMssVariance(0.5, 0.2), 0.1, { stages: regStages(), regulatoryContext: "standard", regCostM: 1.0 }, revenuePV / 1e6);
    const base = buildBaseContext(v, out, { mss: 0.5, variance: 0.2, ptrs: 0.4 }, { trialInputs: design() }, null, devPlan)!;
    const A: OptionInputs = { id: "opt-a", name: "Baseline", isBaseline: true };
    const a = computeOption(base, A);
    // Positive no-precedent evidence → L4 (0.73). Option P scales by exactly 0.73/0.85.
    const noPrec = computeOption(base, { id: "b", name: "No-precedent surrogate", priorFullApprovalsOnEndpoint: "none" }, a);
    expect(noPrec.ptrs).toBeLessThan(a.ptrs - 1e-6);                         // reg down → P down
    expect(noPrec.ptrs / a.ptrs).toBeCloseTo(
      deriveRegConfidence({ designation: "standard", endpointType: "surrogate", regAcceptance: { endpointType: "surrogate", priorFullApprovalsOnEndpoint: "none" } }) / 0.85, 4);
    // Unconfirmed (INFERRED, no observables) → HELD at base rate → no move (absence ≠ penalty).
    const inferred = computeOption(base, { id: "c", name: "Inferred surrogate", endpointEvidenceBasis: "INFERRED" }, a);
    expect(inferred.ptrs).toBeCloseTo(a.ptrs, 6);
  });
});

// ─── Endpoint-semantics pass: categorical trial-P factors deleted; graded reg scale ─────
describe("Endpoint semantics — categorical trial-P factors deleted; reg acceptance graded", () => {
  const design = (o: Partial<TrialDesignInputs> = {}): TrialDesignInputs => ({
    n: 200, endpointType: "surrogate", designType: "rct", populationType: "broad",
    placeboResponse: "low", regulatoryContext: "standard", ...o,
  });

  it("INTERIM FLOOR (E1) — surrogate vs hard give IDENTICAL trial P at equal quantitative params", () => {
    const mix = mixtureFromMssVariance(0.5, 0.2);
    const rr = (endpointType: "surrogate" | "hard") =>
      computeStageRR(mix, 200, 0.20,
        { designType: "rct", endpointType, populationType: "broad", regulatoryContext: "standard" },
        false, undefined, undefined, 0).trialSuccessProb;
    // eslint-disable-next-line no-console
    console.log(`[EPSEM] trial P surrogate=${rr("surrogate")} hard=${rr("hard")} (ENDPOINT_N_FACTOR deleted)`);
    expect(rr("hard")).toBeCloseTo(rr("surrogate"), 12); // endpoint TYPE no longer scales power
  });

  it("PRESERVED — surrogate→time-to-event transition still attenuates the later stage (SURROGATE_TRANSLATION_SIGMA2)", () => {
    const mk = (stage2Tte: boolean) => computeDevPlan(
      mixtureFromMssVariance(0.38, 0.10), 0.1,
      { stages: [
          stage({ trialDesign: design(), n: 80, nullResponseRate: 0.30, isTimeToEvent: false }),
          stage({ id: "stage-2", name: "Ph3", phase: "Phase 3", n: 150, isCurrentTrial: false,
                  trialDesign: design({ n: 150 }), nullResponseRate: 0.30, isTimeToEvent: stage2Tte }),
        ], regulatoryContext: "standard", regCostM: 1.0 },
      1000,
    );
    const noTransition = mk(false), withTransition = mk(true);
    // Assert on the RAW integral (pre-ceiling) to isolate the +0.15 translation variance.
    // nullRR 0.30 ≥ both floors (0.10 / 0.25) → no floor confound; only the transition differs.
    // eslint-disable-next-line no-console
    console.log(`[EPSEM] stage-2 raw trial P — no-transition=${noTransition.stages[1].trialSuccessProbRaw} surrogate→TTE=${withTransition.stages[1].trialSuccessProbRaw}`);
    expect(withTransition.stages[1].trialSuccessProbRaw).toBeLessThan(noTransition.stages[1].trialSuccessProbRaw);
  });

  it("GRADED reg — L1 > L2 > L3 > L4 as distinct deltas; unconfirmed HELD at base; bounded", () => {
    const L1 = deriveRegConfidence({ designation: "standard", endpointType: "hard" });                                                          // +0.03
    const L2 = deriveRegConfidence({ designation: "standard", endpointType: "surrogate", regAcceptance: { endpointType: "surrogate", fdaGuidanceForEndpoint: true } });      // 0
    const L3 = deriveRegConfidence({ designation: "standard", endpointType: "surrogate", regAcceptance: { endpointType: "surrogate", acceleratedOnlyPrecedent: true } });    // −0.06
    const L4 = deriveRegConfidence({ designation: "standard", endpointType: "surrogate", regAcceptance: { endpointType: "surrogate", priorFullApprovalsOnEndpoint: "none" } }); // −0.12 (positive no-precedent)
    const held = deriveRegConfidence({ designation: "standard", endpointType: "surrogate", regAcceptance: { endpointType: "surrogate" } });                                   // unconfirmed → base rate
    // eslint-disable-next-line no-console
    console.log(`[REPIN] reg levels L1=${L1} L2=${L2} L3=${L3} L4=${L4} held=${held}`);
    expect(L1).toBeCloseTo(0.88, 6);
    expect(L2).toBeCloseTo(0.85, 6);
    expect(L3).toBeCloseTo(0.79, 6);
    expect(L4).toBeCloseTo(0.73, 6);
    expect(held).toBeCloseTo(0.85, 6);   // unconfirmed HOLDS at base rate — NOT auto-L4
    expect(L1).toBeGreaterThan(L2); expect(L2).toBeGreaterThan(L3); expect(L3).toBeGreaterThan(L4); // strictly ordered, distinct
    // Anchors: L2 = CONFIRMED; L4 = positive no-precedent; INFERRED-without-observables → held (base).
    expect(deriveRegConfidence({ designation: "standard", endpointType: "surrogate", endpointEvidenceBasis: "CONFIRMED" })).toBeCloseTo(0.85, 6); // = L2
    expect(deriveRegConfidence({ designation: "standard", endpointType: "surrogate", endpointEvidenceBasis: "INFERRED" })).toBeCloseTo(0.85, 6);  // held, NOT L4
    expect(deriveRegConfidence({ designation: "confirmatory", endpointType: "hard" })).toBeCloseTo(0.97, 6);                                      // bounded (cap)
  });

  it("RESOLVED-OR-FLAGGED — positive evidence resolves L1–L4; UNCONFIRMABLE → held_unconfirmed FLAGGED (never auto-L4)", () => {
    expect(resolveRegAcceptanceLevel({ endpointType: "hard" })).toEqual({ level: "L1_precedented_outcome", flagged: false });
    expect(resolveRegAcceptanceLevel({ endpointType: "surrogate", priorFullApprovalsOnEndpoint: "many" })).toEqual({ level: "L2_validated_surrogate", flagged: false });
    expect(resolveRegAcceptanceLevel({ endpointType: "surrogate", approvedInClassOnEndpoint: true })).toEqual({ level: "L2_validated_surrogate", flagged: false });
    expect(resolveRegAcceptanceLevel({ endpointType: "surrogate", acceleratedOnlyPrecedent: true })).toEqual({ level: "L3_thin_precedent", flagged: false });
    // L4 requires POSITIVE evidence of no precedent (approvals explicitly resolved to "none").
    expect(resolveRegAcceptanceLevel({ endpointType: "surrogate", priorFullApprovalsOnEndpoint: "none" })).toEqual({ level: "L4_no_precedent", flagged: true });
    // UNCONFIRMABLE (no observables, no CONFIRMED) → HELD at base rate, flagged — NEVER auto-L4.
    expect(resolveRegAcceptanceLevel({ endpointType: "surrogate" })).toEqual({ level: "held_unconfirmed", flagged: true });
    expect(resolveRegAcceptanceLevel({ endpointType: "surrogate", endpointEvidenceBasis: "INFERRED" })).toEqual({ level: "held_unconfirmed", flagged: true }); // absence ≠ verdict
    expect(resolveRegAcceptanceLevel({ endpointType: "surrogate", endpointEvidenceBasis: "CONFIRMED" })).toEqual({ level: "L2_validated_surrogate", flagged: false });
  });

  it("L3 threads through the SCENARIO-ONLY reg gate: accelerated-only precedent → mid-penalty; base still flat", () => {
    const p = (regEndpoint?: any) => computeDevPlan(mixtureFromMssVariance(0.5, 0.2), 0.1,
      { stages: [stage({ trialDesign: design(), n: 200, nullResponseRate: 0.20 })],
        regulatoryContext: "standard", regCostM: 1.0, ...(regEndpoint ? { regEndpoint } : {}) }, 1000);
    expect(p().regStage.pApproval).toBeCloseTo(0.85, 6);                                                              // base path flat
    expect(p({ endpointType: "surrogate", acceleratedOnlyPrecedent: true }).regStage.pApproval).toBeCloseTo(0.79, 6); // L3 scenario
  });
});

// ─── G2 Phase 2a: CONTINUOUS-endpoint native trial-P power ──────────────────────────────
describe("Continuous endpoint — native two-sample power via sourced SD + Δ (G2 Phase 2a)", () => {
  const mix = mixtureFromMssVariance(0.5, 0.2); // prior mean_rr ≈ 0.5
  const NULL = 0.20;                              // ≥ MEANINGFUL_RR_FLOOR → effectiveNull = 0.20
  const rr = (design: any) => computeStageRR(mix, 60, NULL, design, false, undefined, undefined, 0);
  const propDesign = { designType: "rct" as const, endpointType: "hard" as const, populationType: "broad" as const, regulatoryContext: "standard" as const };
  const contDesign = (outcomeSd: number, expectedDelta: number) => ({ ...propDesign, continuous: { outcomeSd, expectedDelta } });

  it("GATED — a continuous stage with NO sourced SD/Δ is byte-identical to the proportion path", () => {
    const prop = rr(propDesign).trialSuccessProb;
    expect(rr(contDesign(0, 0.5)).trialSuccessProb).toBeCloseTo(prop, 12);   // SD unset/0 → fallback
    expect(rr(contDesign(1.5, 0)).trialSuccessProb).toBeCloseTo(prop, 12);   // Δ unset/0 → fallback
    expect(rr({ ...propDesign, continuous: undefined }).trialSuccessProb).toBeCloseTo(prop, 12);
  });

  it("FIRES + DIVERGES — sourced SD+Δ compute two-sample z-power, not the binomial proxy", () => {
    const prop = rr(propDesign).trialSuccessProb;
    const cont = rr(contDesign(3.0, 0.5)).trialSuccessProb; // small standardized effect → clearly below the proxy
    // eslint-disable-next-line no-console
    console.log(`[G2-2a] proportion proxy P=${prop} | continuous native P=${cont} (divergence expected, labeled not tuned)`);
    expect(cont).toBeGreaterThan(0); expect(cont).toBeLessThan(1);           // bounded
    expect(Math.abs(cont - prop)).toBeGreaterThan(0.05);                     // genuinely different from the proxy
  });

  it("SINGLE-LOCUS (anti-double-count) — varying ONLY SD moves power via se; the prior is untouched", () => {
    const propMean = rr(propDesign).priorMean;
    const small = rr(contDesign(0.8, 1.0));   // tight outcome → high power
    const large = rr(contDesign(4.0, 1.0));   // noisy outcome → low power
    expect(large.trialSuccessProb).toBeLessThan(small.trialSuccessProb);      // larger SD → lower power (precision only)
    // The effect (prior mean) is IDENTICAL across SDs AND identical to the no-channel prior:
    expect(small.priorMean).toBeCloseTo(large.priorMean, 12);
    expect(small.priorMean).toBeCloseTo(propMean, 12);                        // the channel never moved the effect
  });

  it("SANITY — monotone & bounded: larger Δ → higher power; larger SD → lower power; all in [0,1]", () => {
    const P = (sd: number, d: number) => rr(contDesign(sd, d)).trialSuccessProb;
    expect(P(1.5, 1.2)).toBeGreaterThan(P(1.5, 0.3));  // larger Δ → higher power
    expect(P(2.5, 0.6)).toBeLessThan(P(0.8, 0.6));      // larger SD → lower power
    for (const p of [P(0.5, 2.0), P(5.0, 0.2), P(1.5, 1.0)]) { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(1); }
  });

  it("PROPORTION family untouched — a proportion stage's trial P is unchanged (no continuous key)", () => {
    // Two independent proportion computations agree exactly (regression guard: the dispatch
    // never perturbs the proportion path).
    expect(rr(propDesign).trialSuccessProb).toBeCloseTo(rr({ ...propDesign }).trialSuccessProb, 12);
  });

  it("END-TO-END wiring — stage trialDesign.outcomeSd threads through computeDevPlan to native power", () => {
    const contTd = (o: any = {}): TrialDesignInputs => ({
      n: 60, endpointType: "hard", designType: "rct", populationType: "broad",
      placeboResponse: "low", regulatoryContext: "standard", ...o,
    });
    const plan = (td: TrialDesignInputs) => computeDevPlan(mix, 0.1,
      { stages: [stage({ trialDesign: td, n: 60, nullResponseRate: 0.20 })], regulatoryContext: "standard", regCostM: 1.0 }, 1000);
    const proxy = plan(contTd()).stages[0].trialSuccessProbRaw;                                   // no continuous stats → proportion
    const native = plan(contTd({ outcomeSd: 3.0, mdeOrExpectedDelta: 0.5 })).stages[0].trialSuccessProbRaw; // sourced → native
    // eslint-disable-next-line no-console
    console.log(`[G2-2a] computeDevPlan stage-0 raw — proportion=${proxy} native-continuous=${native}`);
    expect(Math.abs(native - proxy)).toBeGreaterThan(0.05); // wiring reaches the engine; diverges from proxy
    expect(plan(contTd({ outcomeSd: 3.0 })).stages[0].trialSuccessProbRaw).toBeCloseTo(proxy, 12); // Δ missing → fallback
  });

  it("FOLLOW-UP 2 — continuous keyDriver: present (read-only) for a continuous option, ABSENT for proportion", () => {
    const td = (o: Partial<TrialDesignInputs> = {}): TrialDesignInputs => ({
      n: 200, endpointType: "hard", designType: "rct", populationType: "broad",
      placeboResponse: "low", regulatoryContext: "standard", ...o,
    });
    const v: Valuation = {
      asset: "CONT", phase: "Phase 2", discountRate: 0.12, cogsPct: 0.2, taxRate: 0.21, workingCapitalPct: 0.1,
      indications: [{ id: "i1", name: "X", peakSales: 1000e6, launchYear: 2032, loeYear: 2044, devCostPV: 300e6 }],
    };
    const revenuePV = computeRevenuePV({ ...v, peakSales: 1000e6, launchYear: 2032, loeYear: 2044 });
    const out = { ptrs: 0.4, revenuePV, devCostPV: 300e6, rnpv: 0 };
    const devPlan = computeDevPlan(mixtureFromMssVariance(0.5, 0.2), 0.1,
      { stages: [stage({ trialDesign: td(), n: 200, nullResponseRate: 0.20 })], regulatoryContext: "standard", regCostM: 1.0 }, revenuePV / 1e6);
    const base = buildBaseContext(v, out, { mss: 0.5, variance: 0.2, ptrs: 0.4 }, { trialInputs: td() }, null, devPlan)!;
    const a = computeOption(base, { id: "opt-a", name: "Baseline", isBaseline: true });
    const cont = computeOption(base, { id: "opt-c", name: "Continuous FVC", outcomeSd: 270, mdeOrExpectedDelta: 90 }, a);
    const prop = computeOption(base, { id: "opt-p", name: "Larger n", n: 240 }, a);
    // Driver present, read-only: surfaces SD/Δ and d = 90/270 = 0.33 (the engine's anchor).
    const contLine = cont.keyDrivers.find((d) => /Continuous endpoint/.test(d));
    expect(contLine).toBeTruthy();
    expect(contLine!).toMatch(/SD 270 \/ Δ 90/);
    expect(contLine!).toMatch(/d 0\.33/);
    // Absent for a proportion-fallback option (no sourced stats).
    expect(prop.keyDrivers.some((d) => /Continuous endpoint/.test(d))).toBe(false);
    // DISPLAY-ONLY: the driver is appended AFTER ptrs is computed → it moves no number. The
    // continuous option's P came from the engine (native power), so it differs from the
    // proportion option; the driver only reports it. (Suite-level: FROZEN byte-identical +
    // the Build-3 OPTION ratio test unchanged prove follow-up 2 altered no computed value.)
    expect(cont.ptrs).toBeGreaterThan(0); expect(cont.ptrs).toBeLessThan(1);
    expect(Math.abs(cont.ptrs - prop.ptrs)).toBeGreaterThan(1e-6); // engine ran native power (not the display)
  });
});
