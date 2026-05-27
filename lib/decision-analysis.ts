// ─── Decision Analysis Engine ─────────────────────────────────────────────────
//
// Computes expected value metrics for 2–4 strategic options, all relative
// to a base valuation (Option A = current plan).
//
// Key outputs per option:
//   eNPV   = PTRS × RevenuePV − DevCostPV
//   eROI   = eNPV / DevCostPV
//   Marginal eROI = ΔeNPV / |ΔDevCost| vs Option A
//
// This engine is pure math — no API calls. It reuses:
//   scoreLayer2()     from ./ptrs-trial    (PTRS recalculation with new trial design)
//   computeRevenuePV() from ./cashflow     (revenue DCF with adjusted peak sales)
//
// ─────────────────────────────────────────────────────────────────────────────

import { scoreLayer2 } from "./ptrs-trial";
import { computeRevenuePV } from "./cashflow";
import type {
  TrialDesignInputs,
  EndpointType,
  DesignType,
  PopulationType,
  PlaceboResponse,
  RegulatoryContext,
} from "./ptrs-trial";
import type { Valuation } from "./types";

// ─── Option Input Types ───────────────────────────────────────────────────────

// The category of strategic change this option represents.
// Multiple categories can apply to one option.
export type OptionCategory =
  | "trial_design"
  | "population"
  | "indication"
  | "voi"
  | "partnership";

// Everything is optional — unset fields inherit from the base valuation.
// Only fill in what changes vs Option A.
export type OptionInputs = {
  id: string;
  name: string;                      // user label, e.g. "Biomarker-first RCT"
  categories?: OptionCategory[];
  isBaseline?: boolean;              // true = Option A (auto-generated)

  // ── Category 1: Trial Design ──────────────────────────────────────────────
  n?: number;                        // sample size
  endpointType?: EndpointType;       // "hard" | "surrogate" | "pro"
  designType?: DesignType;           // "rct" | "single_arm" | "basket"
  numArms?: 1 | 2 | 3 | "adaptive"; // explicit arm count (affects cost; maps to designType)
  populationType?: PopulationType;   // "biomarker_selected" | "broad" | "rare_small"
  placeboResponse?: PlaceboResponse; // "low" | "moderate" | "high"
  regulatoryContext?: RegulatoryContext;

  // ── Category 2: Patient Selection ─────────────────────────────────────────
  // Inclusion criteria tightness affects both PTRS (via population noise)
  // AND peak sales (via label breadth).
  inclusionCriteria?: "tight" | "standard" | "broad";

  // ── Category 4: VOI (Value of Information) ────────────────────────────────
  // "Run a smaller study first, then decide whether to proceed."
  isVOI?: boolean;
  voiType?: "biomarker_validation" | "pilot" | "adaptive_interim" | "dose_optimization";
  voiCostM?: number;                // cost of the preliminary study ($M)
  voiMonths?: number;               // additional months added to timeline
  voiProbPositive?: number;         // P(study positive) — user's belief, 0–1
  voiPtrsBoostIfPositive?: number;  // absolute PTRS boost if study is positive (e.g. 0.08)

  // ── Category 5: Partnership ────────────────────────────────────────────────
  ownershipPct?: number;            // 0–100: % of costs AND revenues retained
  isOutlicensed?: boolean;          // true → royalty model (Licensor) instead of full ownership
  royaltyPctOverride?: number;      // override default royalty if out-licensed

  // ── Manual overrides (bypass calculation) ─────────────────────────────────
  ptrsOverride?: number;            // explicit PTRS (skip Layer 2 recalc)
  peakSalesMOverride?: number;      // explicit peak sales in $M (skip adjustment)
  devCostMOverride?: number;        // explicit dev cost in $M (skip calculation)
};

// ─── Base Context ─────────────────────────────────────────────────────────────
// A snapshot of the current valuation + PTRS Layer 1+2 results.
// This is Option A's parameters — all other options are computed relative to it.

export type BaseContext = {
  // From ptrsResult (Layer 1)
  mss: number;              // Mechanism Signal Strength
  variance: number;         // σ² — uncertainty in mechanism score
  ptrsLayer1: number;       // Layer 1 PTRS before trial design adjustment
  ciHalfWidth: number;      // CI half-width on PTRS

  // From layer2Result (Layer 2) — the current trial design
  baseTrialDesign: TrialDesignInputs;

  // From valuation
  ptrs: number;             // combined PTRS (Layer 1 × Layer 2)
  peakSalesM: number;       // peak sales in $M
  devCostM: number;         // dev cost in $M
  launchYear: number;
  loeYear: number;
  discountRate: number;
  cogsPct: number;
  taxRate: number;
  workingCapitalPct: number;
  avgRoyalty: number;
  ownerType: "Owner" | "Licensor";
  phase: string;
};

// ─── Option Result ─────────────────────────────────────────────────────────────
// Computed outputs for one option.

export type OptionResult = {
  option: OptionInputs;

  // Adjusted inputs
  ptrs: number;
  ptrsCI: { lower: number; upper: number };
  peakSalesM: number;
  devCostM: number;
  revenuePVM: number;         // PV of revenue stream ($M)

  // Primary outputs
  eNPVM: number;              // Expected NPV ($M) = PTRS × RevenuePV − DevCostPV
  eROI: number | null;        // eNPV / devCost (null if devCost = 0)

  // Marginal outputs vs Option A
  deltaENPVM: number | null;  // eNPV(this) − eNPV(A)
  deltaCostM: number | null;  // DevCost(this) − DevCost(A)
  marginalEROI: number | null; // ΔeNPV / |ΔCost|, with sign: + if gaining value, − if losing it

  // Risk profile (eNPV at CI extremes)
  eNPVLowM: number;
  eNPVHighM: number;

  // VOI path (if option.isVOI)
  voiENPVM?: number;          // expected value of the VOI path
  voiVsDirectM?: number;      // VOI eNPV − going straight (vs Option A)

  // Explanations
  keyDrivers: string[];
  ptrsDrivers: string;
};

// ─── Calculation Parameter Tables ─────────────────────────────────────────────

// Design complexity → cost multiplier (relative to 2-arm RCT = 1.0)
const DESIGN_COST_MULT: Record<string, number> = {
  single_arm: 0.70,   // no control arm, simpler logistics
  rct:        1.00,   // 2-arm RCT is the cost baseline
  "3arm":     1.40,   // 3-arm requires 40% more patients + sites
  adaptive:   1.30,   // adaptive adds statistical design complexity
  basket:     1.20,   // multi-basket adds heterogeneity costs
};

// Inclusion criteria tightness → peak sales multiplier
// Tight criteria = fewer eligible patients → smaller label → lower peak sales
// Broad criteria = more patients → wider label → higher peak sales
const INCLUSION_PEAK_SALES_MULT: Record<string, number> = {
  tight:    0.70,
  standard: 1.00,
  broad:    1.20,
};

// Trial design → label strength → peak sales adjustment
// RCT produces stronger label claim vs single arm (payer pushback on single-arm labels)
const DESIGN_PEAK_SALES_MULT: Record<DesignType, number> = {
  rct:        1.10,
  single_arm: 0.90,
  basket:     1.00,
};

// ─── Core Calculation ─────────────────────────────────────────────────────────

export function computeOption(
  base: BaseContext,
  option: OptionInputs,
  optionA?: OptionResult,  // pass undefined when computing Option A itself
): OptionResult {

  // ── Step 1: Resolve trial design inputs (option overrides base) ────────────
  const trialDesign: TrialDesignInputs = {
    n:                 option.n                ?? base.baseTrialDesign.n,
    endpointType:      option.endpointType     ?? base.baseTrialDesign.endpointType,
    designType:        option.designType       ?? base.baseTrialDesign.designType,
    populationType:    option.populationType   ?? base.baseTrialDesign.populationType,
    placeboResponse:   option.placeboResponse  ?? base.baseTrialDesign.placeboResponse,
    regulatoryContext: option.regulatoryContext ?? base.baseTrialDesign.regulatoryContext,
    nctId:              base.baseTrialDesign.nctId,
    endpointDescription: base.baseTrialDesign.endpointDescription,
    enrollmentNote:     base.baseTrialDesign.enrollmentNote,
  };

  // ── Step 2: Adjusted PTRS ─────────────────────────────────────────────────
  let ptrs: number;
  let ptrsCI: { lower: number; upper: number };

  if (option.ptrsOverride != null) {
    ptrs = clamp01(option.ptrsOverride);
    ptrsCI = {
      lower: Math.max(0.01, ptrs - base.ciHalfWidth),
      upper: Math.min(0.99, ptrs + base.ciHalfWidth),
    };
  } else {
    const l2 = scoreLayer2(
      base.mss,
      base.variance,
      base.ptrsLayer1,
      base.ciHalfWidth,
      trialDesign,
    );
    ptrs = l2.ptrsCombined;
    ptrsCI = l2.ptrsCI;
  }

  // ── Step 3: Adjusted peak sales ───────────────────────────────────────────
  let peakSalesM: number;

  if (option.peakSalesMOverride != null) {
    peakSalesM = option.peakSalesMOverride;
  } else {
    peakSalesM = base.peakSalesM;

    // Apply design type → label strength adjustment (only if design is changing)
    if (option.designType && option.designType !== base.baseTrialDesign.designType) {
      const baseDsgn = base.baseTrialDesign.designType;
      peakSalesM = peakSalesM
        * (DESIGN_PEAK_SALES_MULT[option.designType] ?? 1.0)
        / (DESIGN_PEAK_SALES_MULT[baseDsgn] ?? 1.0);
    }

    // Apply inclusion criteria → label breadth
    if (option.inclusionCriteria && option.inclusionCriteria !== "standard") {
      peakSalesM *= INCLUSION_PEAK_SALES_MULT[option.inclusionCriteria];
    }

    // Apply ownership/partnership
    if (option.ownershipPct != null) {
      peakSalesM *= option.ownershipPct / 100;
    } else if (option.isOutlicensed && !base.ownerType.includes("Licensor")) {
      // Out-licensing: only capture royalty × peak sales instead of full ownership
      const royalty = option.royaltyPctOverride ?? base.avgRoyalty;
      peakSalesM *= royalty;
    }
  }

  // ── Step 4: Adjusted dev cost ─────────────────────────────────────────────
  let devCostM: number;

  if (option.devCostMOverride != null) {
    devCostM = option.devCostMOverride;
  } else {
    const baseN = base.baseTrialDesign.n;
    const optionN = trialDesign.n;

    // Sample size scaling: costs scale sub-linearly at n^0.75
    // (fixed costs like regulatory, manufacturing, sites don't grow proportionally with n)
    const nScale = baseN > 0 ? Math.pow(optionN / baseN, 0.75) : 1;

    // Design complexity: 3-arm or adaptive costs more than base design
    const resolvedDesignKey = (() => {
      if (option.numArms === 3) return "3arm";
      if (option.numArms === "adaptive") return "adaptive";
      return option.designType ?? base.baseTrialDesign.designType;
    })();
    const baseDesignKey = base.baseTrialDesign.designType;
    const complexityAdjust =
      (DESIGN_COST_MULT[resolvedDesignKey] ?? 1.0) /
      (DESIGN_COST_MULT[baseDesignKey] ?? 1.0);

    devCostM = base.devCostM * nScale * complexityAdjust;

    // Ownership adjustment
    if (option.ownershipPct != null) {
      devCostM *= option.ownershipPct / 100;
    } else if (option.isOutlicensed) {
      // Out-licensed: partner pays R&D, company receives milestones + royalties
      // Dev cost to licensor ≈ 5% (deal overhead only)
      devCostM *= 0.05;
    }

    // VOI: add study cost + time value of delay
    if (option.isVOI && option.voiCostM) {
      devCostM += option.voiCostM;
      if (option.voiMonths && option.voiMonths > 0) {
        // Monthly burn rate based on 36-month expected dev period
        const monthlyBurn = base.devCostM / 36;
        devCostM += option.voiMonths * monthlyBurn;
      }
    }

    devCostM = Math.max(0, devCostM);
  }

  // ── Step 5: Revenue PV ────────────────────────────────────────────────────
  // Delay launch year for VOI options
  const launchDelay = option.isVOI && option.voiMonths
    ? Math.ceil(option.voiMonths / 12)
    : 0;

  const revPVInput = {
    peakSales:            peakSalesM * 1e6,
    launchYear:           base.launchYear + launchDelay,
    loeYear:              base.loeYear + launchDelay,
    discountRate:         base.discountRate,
    cogsPct:              base.cogsPct,
    taxRate:              base.taxRate,
    workingCapitalPct:    base.workingCapitalPct,
    avgRoyalty:           option.royaltyPctOverride ?? base.avgRoyalty,
    ownerType:            option.isOutlicensed ? "Licensor" as const : base.ownerType,
  } as Valuation;

  const revenuePVM = computeRevenuePV(revPVInput) / 1e6;

  // ── Step 6: eNPV ─────────────────────────────────────────────────────────
  const eNPVM = round1(ptrs * revenuePVM - devCostM);

  // ── Step 7: eROI ─────────────────────────────────────────────────────────
  const eROI = devCostM > 0.1 ? round2(eNPVM / devCostM) : null;

  // ── Step 8: Marginal eROI vs Option A ────────────────────────────────────
  let deltaENPVM: number | null = null;
  let deltaCostM: number | null = null;
  let marginalEROI: number | null = null;

  if (optionA && !option.isBaseline) {
    deltaENPVM = round1(eNPVM - optionA.eNPVM);
    deltaCostM = round1(devCostM - optionA.devCostM);

    if (Math.abs(deltaCostM) > 0.5) {
      // Sign convention:
      //   deltaCostM > 0 (costs more): marginalEROI = ΔeNPV / ΔCost
      //   deltaCostM < 0 (saves money): marginalEROI = ΔeNPV / |ΔCost|
      //     → positive marginal means: every dollar NOT spent returns more eNPV
      marginalEROI = round2(deltaENPVM / Math.abs(deltaCostM));
    }
  }

  // ── Step 9: Risk profile (eNPV at CI bounds) ──────────────────────────────
  const eNPVLowM  = round1(ptrsCI.lower * revenuePVM - devCostM);
  const eNPVHighM = round1(ptrsCI.upper * revenuePVM - devCostM);

  // ── Step 10: VOI calculation ──────────────────────────────────────────────
  let voiENPVM: number | undefined;
  let voiVsDirectM: number | undefined;

  if (option.isVOI && option.voiProbPositive != null) {
    const pPos = option.voiProbPositive;
    const voiStudyCost = option.voiCostM ?? 0;

    // If positive: PTRS gets a boost (confirms signal) → compute eNPV of proceeding
    const ptrsIfPositive = option.voiPtrsBoostIfPositive
      ? clamp01(ptrs + option.voiPtrsBoostIfPositive)
      : clamp01(ptrs * 1.15);  // default: 15% relative boost if positive

    // eNPV of going forward after a positive study (dev cost already includes study cost)
    const eNPVIfPositive = ptrsIfPositive * revenuePVM - devCostM;

    // If negative: stop development, save remaining dev cost → eNPV = 0
    // (study cost is sunk but the larger dev cost is avoided)
    const eNPVIfNegative = 0;

    voiENPVM = round1(pPos * eNPVIfPositive + (1 - pPos) * eNPVIfNegative);

    if (optionA) {
      voiVsDirectM = round1(voiENPVM - optionA.eNPVM);
    }
  }

  // ── Step 11: Explanations ─────────────────────────────────────────────────
  const keyDrivers: string[] = [];
  const ptrsDiff = ptrs - base.ptrs;

  if (Math.abs(ptrsDiff) > 0.005) {
    keyDrivers.push(`PTRS ${ptrsDiff >= 0 ? "+" : ""}${(ptrsDiff * 100).toFixed(1)}% vs base`);
  }
  if (option.designType && option.designType !== base.baseTrialDesign.designType) {
    const from = base.baseTrialDesign.designType.replace("_", " ");
    const to   = option.designType.replace("_", " ");
    keyDrivers.push(`Design: ${from} → ${to}`);
  }
  if (option.n && option.n !== base.baseTrialDesign.n) {
    keyDrivers.push(`n: ${base.baseTrialDesign.n} → ${option.n}`);
  }
  if (option.inclusionCriteria && option.inclusionCriteria !== "standard") {
    keyDrivers.push(
      `${option.inclusionCriteria} inclusion → peak sales ×${INCLUSION_PEAK_SALES_MULT[option.inclusionCriteria]}`
    );
  }
  if (option.ownershipPct != null) {
    keyDrivers.push(`${option.ownershipPct}% ownership (costs + revenue)`);
  }
  if (option.isOutlicensed) {
    keyDrivers.push(`Out-licensed → ${((option.royaltyPctOverride ?? base.avgRoyalty) * 100).toFixed(0)}% royalty`);
  }
  if (option.isVOI) {
    keyDrivers.push(`VOI: $${option.voiCostM ?? 0}M study + ${option.voiMonths ?? 0}mo delay`);
  }
  if (option.numArms === 3) {
    keyDrivers.push("3-arm design → cost ×1.4 vs 2-arm RCT");
  }

  const ptrsDrivers = Math.abs(ptrsDiff) > 0.005
    ? `PTRS ${ptrsDiff >= 0 ? "+" : ""}${(ptrsDiff * 100).toFixed(1)}% vs base ` +
      `(${(base.ptrs * 100).toFixed(1)}% → ${(ptrs * 100).toFixed(1)}%)`
    : `PTRS unchanged at ${(ptrs * 100).toFixed(1)}%`;

  return {
    option,
    ptrs, ptrsCI,
    peakSalesM, devCostM, revenuePVM,
    eNPVM, eROI,
    deltaENPVM, deltaCostM, marginalEROI,
    eNPVLowM, eNPVHighM,
    voiENPVM, voiVsDirectM,
    keyDrivers, ptrsDrivers,
  };
}

// ─── Compute All Options ──────────────────────────────────────────────────────
// Call this to compute the full comparison. Options[0] should be the baseline.

export function computeAllOptions(
  base: BaseContext,
  options: OptionInputs[],
): OptionResult[] {
  const results: OptionResult[] = [];
  let optionA: OptionResult | undefined;

  for (const opt of options) {
    const result = computeOption(base, opt, optionA);
    results.push(result);
    if (opt.isBaseline || !optionA) optionA = result;
  }
  return results;
}

// ─── Build Base Context from Valuation ────────────────────────────────────────
// Call this in the UI to create the BaseContext from current page state.
// Returns null if the valuation doesn't have enough data yet.

export function buildBaseContext(
  v: Valuation,
  out: { ptrs: number; revenuePV: number; devCostPV: number; rnpv: number },
  ptrsResult: any,   // result from /api/ptrs-score
  layer2Result: any, // result from /api/ptrs-layer2
): BaseContext | null {
  // Need at least some financial data
  const peakSalesRaw = v.indications?.[0]?.peakSales ?? v.peakSales ?? 0;
  const devCostRaw   = v.indications?.[0]?.devCostPV ?? v.devCostPV ?? 0;

  if (!peakSalesRaw && !devCostRaw && !v.asset) return null;

  // Derive base trial design from Layer 2 if available, else phase-appropriate defaults
  const baseTrialDesign: TrialDesignInputs = layer2Result?.inputs ?? {
    n:                 estimateDefaultN(v.phase),
    endpointType:      "surrogate" as EndpointType,
    designType:        "single_arm" as DesignType,
    populationType:    "broad" as PopulationType,
    placeboResponse:   "low" as PlaceboResponse,
    regulatoryContext: "standard" as RegulatoryContext,
  };

  const ptrsLayer1 = ptrsResult?.ptrs ?? out.ptrs;
  const ciHalfWidthFromResult = ptrsResult?.ptrsCI
    ? (ptrsResult.ptrsCI.upper - ptrsResult.ptrsCI.lower) / 2
    : 0.10;

  const currentYear = new Date().getFullYear();

  return {
    mss:          ptrsResult?.mss ?? 0.5,
    variance:     ptrsResult?.variance ?? 0.3,
    ptrsLayer1,
    ciHalfWidth:  ciHalfWidthFromResult,
    baseTrialDesign,
    ptrs:         out.ptrs,
    peakSalesM:   peakSalesRaw / 1e6,
    devCostM:     devCostRaw / 1e6,
    launchYear:   v.indications?.[0]?.launchYear ?? v.launchYear ?? currentYear + 5,
    loeYear:      v.indications?.[0]?.loeYear    ?? v.loeYear    ?? currentYear + 15,
    discountRate:         v.discountRate         ?? 0.12,
    cogsPct:              v.cogsPct              ?? 0.20,
    taxRate:              v.taxRate              ?? 0.21,
    workingCapitalPct:    v.workingCapitalPct    ?? 0.10,
    avgRoyalty:           v.avgRoyalty           ?? 0.15,
    ownerType:            v.ownerType            ?? "Owner",
    phase:                v.phase                ?? "Phase 2",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function round1(x: number)  { return Math.round(x * 10) / 10; }
function round2(x: number)  { return Math.round(x * 100) / 100; }

function estimateDefaultN(phase?: string): number {
  const defaults: Record<string, number> = {
    Preclinical: 10,
    "Phase 1":   20,
    "Phase 2":   50,
    "Phase 3":  200,
    Filed:      200,
    Approved:    50,
  };
  return defaults[phase ?? "Phase 2"] ?? 50;
}
