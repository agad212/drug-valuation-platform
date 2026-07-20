// ─── Offline fixture runner (TEST-ONLY) ───────────────────────────────────────
//
// Loads a captured/reconstructed fixture (the INPUTS that feed the deterministic
// valuation layer) and runs the EXISTING production functions on it — unchanged.
// Zero API calls, zero network, fully offline. This mirrors the live wiring in
// pages/index.tsx (effect prior → revenue PV → computeDevPlan) so the harness
// reproduces headline results without a paid live valuation.
//
// This file imports live functions but is NEVER imported by live code — it lives
// under tests/ and is only pulled in by *.test.ts files.

import { readFileSync } from "node:fs";
import { buildEffectPrior, mixtureMoments, type EvidenceStepInput, type EffectPrior } from "../../lib/effect-prior";
import { computeDevPlan, type DevStageInput, type DevPlanResult } from "../../lib/dev-plan";
import { classGraveyardProbability } from "../../lib/class-risk";
import { computeRevenuePV } from "../../lib/cashflow";
import {
  anchorPeakSales, computeLoeYear,
  type TherapeuticArea, type Modality, type PeakComp, type PeakPin, type LoePin,
} from "../../lib/financial-pins";
import type { RegulatoryContext } from "../../lib/ptrs-trial";

// ── Fixture shape ──────────────────────────────────────────────────────────────
// A fixture is ONLY inputs (+ documented expected headline). It captures "here is
// what the model/retrieval produced; now does the deterministic math handle it?"

/** Subset of Valuation that computeRevenuePV actually reads (see lib/cashflow.ts). */
export type FixtureValuation = {
  peakSales: number;
  launchYear: number;
  loeYear: number;
  discountRate?: number;
  cogsPct?: number;
  taxRate?: number;
  workingCapitalPct?: number;
  avgRoyalty?: number;
  ownerType?: "Owner" | "Licensor";
};

export type Fixture = {
  meta: {
    asset: string;
    capturedAt: string;
    note: string;
    /** Documented headline band at capture time — the harness asserts within these. */
    expectedHeadline: {
      pApprovalBand: [number, number];
      classStatus: "graveyard" | "precedent" | "mixed" | "none" | null;
      appliesModalityHaircut: boolean;
      note?: string;
    };
  };
  ciHalfWidth: number;
  /** Evidence chain fed to buildEffectPrior (step 0 MUST be mechanism/found). */
  chainSteps: EvidenceStepInput[];
  /** Dev-plan inputs as they enter computeDevPlan (post-pin, post-parse). */
  devPlan: {
    regulatoryContext: RegulatoryContext;
    regCostM?: number;
    stages: DevStageInput[];
    orphanConfirmedForIndication?: boolean; // Fix B: gates the orphan engine benefit
  };
  /** Revenue inputs as they enter computeRevenuePV. peakSales/loeYear here are the
   *  RAW LLM/auto-value values (kept for provenance); the PINNED values are derived
   *  from `financial` below (Fix #2). */
  valuation: FixtureValuation;
  /** Fix #2 pin inputs: TA (→ cost benchmark), modality (→ LOE term), retrieved
   *  comps (→ peak anchor), optional real patent LOE. Absent on pre-Fix-#2 fixtures. */
  financial?: {
    therapeuticArea: TherapeuticArea;
    modality: Modality;
    patentLoeYear?: number | null;
    comps: PeakComp[];
  };
  /** Golden outputs, filled from a real offline run; asserted with tolerances. */
  expected?: Record<string, number>;
};

export type ChainResult = {
  effectPrior: EffectPrior;
  modalityClassStatus: "graveyard" | "precedent" | "mixed" | "none" | undefined;
  revenuePV: number;
  revenuePVM: number;
  devPlan: DevPlanResult;
  peakPin: PeakPin | null;   // Fix #2: how base peak sales was anchored (null if no financial block)
  loePin: LoePin | null;     // Fix #2: how LOE was derived (null if no financial block)
};

export function loadFixture(fileName: string): Fixture {
  const url = new URL(`../fixtures/${fileName}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8")) as Fixture;
}

/**
 * Run the full deterministic chain on a fixture, mirroring pages/index.tsx:
 *   buildEffectPrior(chain) → mixture
 *   modalityClassStatus = analog step's classStatus (index.tsx:504)
 *   revenuePVM = computeRevenuePV(valuation) / 1e6 (index.tsx:500)
 *   computeDevPlan(mixture, ciHalfWidth, { stages, regContext, regCostM, modalityClassStatus }, revenuePVM)
 *
 * NOTE: computeRevenuePV and computeDevPlan→impliedLaunchYear read the current
 * year. Callers MUST pin the clock (vi.setSystemTime) for deterministic output.
 */
export function runDeterministicChain(fx: Fixture): ChainResult {
  const effectPrior = buildEffectPrior(fx.chainSteps);
  // Part 2: derive p_graveyard + the classStatus label deterministically from the
  // analog step's STRUCTURED facts when present (mirrors index.tsx); else fall back
  // to the LLM classStatus label (backward-compatible — pre-Part-2 fixtures).
  const analogStep = effectPrior.chain.find((s) => s.source === "analog");
  const classRisk = analogStep?.classEvidence ? classGraveyardProbability(analogStep.classEvidence) : null;
  const modalityClassStatus = classRisk?.classStatus ?? analogStep?.classStatus;

  const devPlanInputs = {
    stages: fx.devPlan.stages,
    regulatoryContext: fx.devPlan.regulatoryContext,
    regCostM: fx.devPlan.regCostM ?? 1.0,
    modalityClassStatus,
    classGraveyardProbability: classRisk?.pGraveyard,
    therapeuticArea: fx.financial?.therapeuticArea,
    orphanConfirmedForIndication: fx.devPlan.orphanConfirmedForIndication,
  };

  // ── Fix #2: pin peak sales (comp-anchored) and LOE (real-or-labeled-rule) ──────
  // Anchor to the TIMELINE-derived launch year (Fix #1's impliedLaunchYear), which
  // is what the live app uses for revenue after the launch-year reset — NOT the raw
  // auto-value launch guess. impliedLaunchYear is revenue-independent, so pass 1 can
  // use a placeholder revenue purely to read it; pass 2 uses the real revenuePVM.
  // (pApproval/stage probabilities are identical between passes — revenue never
  // touches them.) computeRevenuePV itself is left untouched.
  const fin = fx.financial;
  const launchYear = computeDevPlan(effectPrior.mixture, fx.ciHalfWidth, devPlanInputs, 0).impliedLaunchYear;

  const peakPin = fin
    ? anchorPeakSales(fin.comps, { rawLlmPeakM: (fx.valuation.peakSales || 0) / 1e6 })
    : null;
  const loePin = fin
    ? computeLoeYear({
        launchYear,
        modality: fin.modality,
        regulatoryContext: fx.devPlan.regulatoryContext,
        patentLoeYear: fin.patentLoeYear ?? null,
        orphanConfirmed: fx.devPlan.orphanConfirmedForIndication === true,
      })
    : null;

  const valuation = {
    ...fx.valuation,
    launchYear,
    peakSales: peakPin ? peakPin.baseM * 1e6 : fx.valuation.peakSales,
    loeYear: loePin ? loePin.loeYear : fx.valuation.loeYear,
  };

  const revenuePV = computeRevenuePV(valuation as any);
  const revenuePVM = revenuePV / 1e6;

  const devPlan = computeDevPlan(effectPrior.mixture, fx.ciHalfWidth, devPlanInputs, revenuePVM);

  return { effectPrior, modalityClassStatus, revenuePV, revenuePVM, devPlan, peakPin, loePin };
}

/**
 * Flatten a chain result into the scalar "headline" numbers the harness locks on
 * and the capture script writes into a fixture's `expected` block. Shared so the
 * two can never drift.
 */
export function headline(r: ChainResult) {
  const p = r.devPlan;
  return {
    finalMss: mixtureMoments(r.effectPrior.mixture).mss,
    pApproval: p.pApproval,
    pAllTrialsSuccess: p.pAllTrialsSuccess,
    s0_trialSuccessProb: p.stages[0].trialSuccessProb,
    s0_trialSuccessProbRaw: p.stages[0].trialSuccessProbRaw,
    s0_modalityHaircut: p.stages[0].modalityHaircut,
    s1_trialSuccessProb: p.stages[1]?.trialSuccessProb ?? null,
    s1_modalityHaircut: p.stages[1]?.modalityHaircut ?? null,
    totalDurationMonths: p.totalDurationMonths,
    impliedLaunchYear: p.impliedLaunchYear,
    // Fix #2 pinned dollar inputs (deterministic — these replace the swinging LLM values)
    s0_cpp: p.stages[0].cpp,
    s1_cpp: p.stages[1]?.cpp ?? null,
    totalRiskAdjCostM: p.totalRiskAdjCostM,
    peakSalesM: r.peakPin ? r.peakPin.baseM : null,
    loeYear: r.loePin ? r.loePin.loeYear : null,
    revenuePVM: r.revenuePVM,
    eNPVM: p.eNPVM,
    eROI: p.eROI,
  };
}
