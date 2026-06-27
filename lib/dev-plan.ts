// ─── Development Plan Engine ──────────────────────────────────────────────────
//
// Models the full remaining development path as a sequence of discrete trial
// stages, each with its own probability, cost, and Bayesian drug-truth update.
//
// Core logic:
//   1. Each stage runs Layer 2 scoreLayer2() with its specific trial design
//      to get P(trial succeeds | drug is real) against the current effect
//      mixture from the True Effect Prior.
//   2. After each successful trial, the mixture is updated: each component's
//      (mu, sigma2) tightens (Bayesian posterior) AND its weight is reweighted
//      by how much it contributed to this success (full Bayes mixture-weight
//      update). For a 1-component mixture this reduces exactly to the old
//      scalar MSS/variance update.
//   3. Costs are risk-adjusted: each trial cost × P(all prior stages succeeded).
//      → Phase 2: paid in full (already committed)
//      → Phase 3: × P(Phase 2 success)
//      → Reg: × P(Phase 2) × P(Phase 3)
//   4. Timeline: each stage's duration = enrollment time (n / enrollment rate)
//      + treatment/observation period + study-startup cushion.
//   5. eNPV = P(approval) × Revenue PV − total risk-adjusted cost
//
// This replaces the single-PTRS model with an explicit stage-by-stage path.
//
// ─────────────────────────────────────────────────────────────────────────────

import { scoreLayer2 } from "./ptrs-trial";
import type {
  TrialDesignInputs,
  TrialRiskFlag,
  EndpointType,
  RegulatoryContext,
} from "./ptrs-trial";
import { mixtureMoments, type EffectPriorMixture } from "./effect-prior";
import {
  computeStageRR,
  gridToGaussianMixture,
  downsampleGrid,
  type RRBands,
  type RRTrialDesign,
} from "./bayesian-rr";

// ─── REMOVED: Fixed heuristic constants ──────────────────────────────────────
// MSS_UPLIFT_BY_ENDPOINT, VARIANCE_REDUCTION, MAX_MU are GONE.
// Posterior updating is now done by the Bayesian response-rate engine
// (lib/bayesian-rr.ts) — tightening emerges from trial statistical
// power, not fixed factors.

// ─── Regulatory approval probability ─────────────────────────────────────────
// P(FDA/EMA approves | all clinical trials succeeded)
// Based on industry data (DiMasi et al.; BioMedtracker FDA approval rates)

const REG_APPROVAL_PROB: Record<RegulatoryContext, number> = {
  standard:      0.85,
  btd:           0.92,
  orphan:        0.90,
  btd_orphan:    0.94,
  accelerated:   0.88,
  confirmatory:  0.95,
};

// ─── Regulatory review timeline ───────────────────────────────────────────────
// Typical FDA review duration (months), submission to decision, by pathway.
const REVIEW_MONTHS_BY_REG_CONTEXT: Record<RegulatoryContext, number> = {
  standard:      12,
  btd:            8,
  orphan:        10,
  btd_orphan:     8,
  accelerated:    8,
  confirmatory:  14,
};

// ─── Phase baseline PTRS ──────────────────────────────────────────────────────
// Mirrors ptrs-score.ts and ptrs-mechanism-scorer.ts
const PHASE_BASELINE: Record<string, number> = {
  Preclinical: 0.07,
  "Phase 1":   0.14,
  "Phase 2":   0.25,
  "Phase 3":   0.55,
  Filed:       0.85,
  Approved:    1.00,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type DevStageInput = {
  id: string;
  name: string;             // e.g. "ABACUS-2 (Phase 2)" or "KIO-301 Registration Study"
  phase: string;            // "Phase 1" | "Phase 2" | "Phase 3"
  n: number;                // planned enrollment
  cpp: number;              // cost per patient in dollars (e.g. 200000 = $200K)
  trialDesign: TrialDesignInputs;
  isCurrentTrial: boolean;  // true = already running; false = future/hypothetical
  aiRationale?: string;     // why this stage exists (from API)

  // Timeline economics — per-patient, indication-aware (AI-estimated, see
  // pages/api/dev-plan.ts "TRIAL DURATION BENCHMARKS")
  enrollmentRatePerMonth: number; // patients enrolled per month, across all sites
  treatmentObsMonths: number;     // treatment + follow-up/observation period
  startupCushionMonths: number;   // site activation, IRB/EC approval, first-patient-in

  // Bayesian RR engine inputs (AI-estimated or user-entered)
  nullResponseRate?: number;      // SOC/historical control response rate (0-1)
  observedResponseRate?: number;  // actual observed RR from a completed trial
  observedN?: number;             // n for the observed result
  isTimeToEvent?: boolean;        // true = OS/PFS/DFS endpoint, approximated via RR proxy
};

// Computed result for one stage
export type DevStage = DevStageInput & {
  // Drug truth going into this stage (derived from mixtureInput)
  mssInput: number;
  varianceInput: number;
  ptrsLayer1Input: number;  // phase baseline + mechanism adjustment given mssInput

  // Full effect-strength mixture going into / coming out of this stage — the
  // source of truth. mssInput/varianceInput/mssIfSuccess/varianceIfSuccess are
  // derived from these via mixtureMoments() for backward-compatible display.
  mixtureInput: EffectPriorMixture;
  mixtureIfSuccess: EffectPriorMixture;

  // Layer 2 result
  trialSuccessProb: number; // Σ wᵢ·Φ(zᵢ) — P(this trial detects effect)
  layer2Multiplier: number;
  sigma2Trial: number;
  riskFlags: TrialRiskFlag[];

  // Drug truth if this stage succeeds (Bayesian posterior, derived from mixtureIfSuccess)
  mssIfSuccess: number;
  varianceIfSuccess: number;

  // Cost accounting
  trialCostM: number;          // n × cpp / 1e6
  pPriorSuccess: number;       // P(all prior stages succeeded) — cost multiplier
  riskAdjCostM: number;        // trialCostM × pPriorSuccess

  // Timeline (months)
  enrollmentMonths: number;     // n / enrollmentRatePerMonth
  durationMonths: number;       // enrollmentMonths + treatmentObsMonths + startupCushionMonths

  // Cumulative probability through this stage
  cumSuccessProb: number;      // pPriorSuccess × trialSuccessProb

  // ── Bayesian RR diagnostics (from lib/bayesian-rr.ts) ──
  rrPriorGrid?: { theta: number[]; density: number[] };     // downsampled ~60 pts for UI
  rrPosteriorGrid?: { theta: number[]; density: number[] }; // downsampled ~60 pts for UI
  bandsBefore?: RRBands;
  bandsAfter?: RRBands;
  nullResponseRate: number;
  isProxied?: boolean;           // true if TTE endpoint approximated via RR proxy
  counterfactuals?: { label: string; pSuccess: number }[];
};

export type RegStage = {
  costM: number;               // fixed regulatory cost (default $1M)
  pApproval: number;           // P(approval | all trials succeed)
  regulatoryContext: RegulatoryContext;
  pPriorSuccess: number;       // P(all clinical trials succeeded)
  riskAdjCostM: number;        // costM × pPriorSuccess
  reviewMonths: number;        // typical FDA/EMA review duration for this pathway
};

export type DevPlanResult = {
  stages: DevStage[];
  regStage: RegStage;

  // Summary probabilities
  pAllTrialsSuccess: number;   // product of all stage trialSuccessProb values
  pApproval: number;           // pAllTrialsSuccess × regStage.pApproval

  // Summary costs
  totalNominalCostM: number;   // sum of un-adjusted costs
  totalRiskAdjCostM: number;   // sum of risk-adjusted costs (what goes into eNPV)

  // Summary timeline
  totalDurationMonths: number; // sum of stage durationMonths + regStage.reviewMonths

  // Value outputs
  revenuePVM: number;          // from base context
  eNPVM: number;               // pApproval × revenuePVM − totalRiskAdjCostM
  eROI: number | null;         // eNPVM / totalRiskAdjCostM
};

// Inputs for the full plan computation
export type DevPlanInputs = {
  stages: DevStageInput[];
  regulatoryContext: RegulatoryContext; // drives reg approval probability
  regCostM?: number;                   // override default $1M
};

// Default null/control response rates by phase (when AI doesn't provide one)
const DEFAULT_NULL_RR: Record<string, number> = {
  "Preclinical": 0.05,
  "Phase 1":     0.10,
  "Phase 2":     0.15,
  "Phase 3":     0.20,
  "Filed":       0.20,
};

// ─── Core computation ─────────────────────────────────────────────────────────

export function computeDevPlan(
  // Current drug effect-strength mixture (from the True Effect Prior — 1
  // component in the normal case, 2 if evidence has genuinely split)
  mixture: EffectPriorMixture,
  ciHalfWidth: number,
  // Plan definition
  inputs: DevPlanInputs,
  // Revenue (from existing valuation)
  revenuePVM: number,
): DevPlanResult {

  const stages: DevStage[] = [];
  let currentMixture: EffectPriorMixture = mixture;
  let cumPriorSuccess = 1.0; // P(all prior stages succeeded); starts at 1 (nothing has failed yet)

  for (const stageInput of inputs.stages) {

    const { mss: currentMSS, variance: currentVariance } = mixtureMoments(currentMixture);

    // ── Derive ptrsLayer1 for this stage's phase ─────────────────────────────
    // Phase baseline + asymmetric mechanism adjustment (same formula as
    // ptrs-mechanism-scorer.ts scoreMechanism → ptrsAdjustment)
    const phaseBase = PHASE_BASELINE[stageInput.phase] ?? 0.25;
    const mechAdj = currentMSS >= 0.5
      ? Math.min((currentMSS - 0.5) * 0.55, 0.20)
      : Math.max((currentMSS - 0.5) * 0.30, -0.15);
    const ptrsLayer1 = clamp01(phaseBase + mechAdj);

    // ── Layer 2: still called for risk flags, multiplier, sigma2Trial ────────
    const l2 = scoreLayer2(
      currentMixture,
      ptrsLayer1,
      ciHalfWidth,
      stageInput.trialDesign,
    );

    // ── Bayesian RR engine: true posterior updating ──────────────────────────
    // P(success) comes from numerical integration over the response-rate
    // distribution, NOT from the Gaussian Φ(z) heuristic. The posterior
    // after success is computed via Bayes' rule on the discretized grid,
    // so tightening EMERGES from the trial's statistical power.
    const nullRR = stageInput.nullResponseRate
      ?? DEFAULT_NULL_RR[stageInput.phase]
      ?? 0.15;

    const rrDesign: RRTrialDesign = {
      designType:        stageInput.trialDesign.designType,
      endpointType:      stageInput.trialDesign.endpointType,
      populationType:    stageInput.trialDesign.populationType,
      regulatoryContext: stageInput.trialDesign.regulatoryContext,
    };

    const rrResult = computeStageRR(
      currentMixture,
      stageInput.n,
      nullRR,
      rrDesign,
      stageInput.isTimeToEvent === true,
      stageInput.observedResponseRate,
      stageInput.observedN,
    );

    const trialSuccessProb = rrResult.trialSuccessProb;

    // Convert the posterior grid back to a Gaussian mixture for the next stage
    const mixtureIfSuccess = gridToGaussianMixture(
      rrResult.posteriorGrid,
      currentMixture.length,
    );
    const { mss: mssIfSuccess, variance: varianceIfSuccess } = mixtureMoments(mixtureIfSuccess);

    // ── Cost accounting ───────────────────────────────────────────────────────
    const trialCostM   = (stageInput.n * stageInput.cpp) / 1e6;
    // Risk-adjusted: this trial only happens if all prior stages succeeded
    const riskAdjCostM = trialCostM * cumPriorSuccess;
    // Cumulative probability through this stage
    const cumSuccessProb = cumPriorSuccess * trialSuccessProb;

    // ── Timeline ───────────────────────────────────────────────────────────────
    // Enrollment time scales with n; treatment/observation and startup cushion
    // are roughly fixed regardless of trial size.
    const enrollmentMonths = stageInput.n / Math.max(stageInput.enrollmentRatePerMonth, 0.1);
    const durationMonths = enrollmentMonths + stageInput.treatmentObsMonths + stageInput.startupCushionMonths;

    stages.push({
      ...stageInput,
      mssInput:          currentMSS,
      varianceInput:     currentVariance,
      ptrsLayer1Input:   ptrsLayer1,
      mixtureInput:      currentMixture,
      mixtureIfSuccess,
      trialSuccessProb,
      layer2Multiplier:  l2.layer2Multiplier,
      sigma2Trial:       l2.sigma2Trial,
      riskFlags:         l2.riskFlags,
      mssIfSuccess,
      varianceIfSuccess,
      trialCostM,
      pPriorSuccess:     cumPriorSuccess,
      riskAdjCostM,
      enrollmentMonths,
      durationMonths,
      cumSuccessProb,
      // Bayesian RR diagnostics
      rrPriorGrid:       downsampleGrid(rrResult.priorGrid),
      rrPosteriorGrid:   downsampleGrid(rrResult.posteriorGrid),
      bandsBefore:       rrResult.bandsBefore,
      bandsAfter:        rrResult.bandsAfter,
      nullResponseRate:  rrResult.effectiveNullRR,
      isProxied:         stageInput.isTimeToEvent === true,
      counterfactuals:   rrResult.counterfactuals,
    });

    // Advance drug truth for next stage: assume this stage succeeds
    currentMixture  = mixtureIfSuccess;
    cumPriorSuccess = cumSuccessProb;
  }

  // ── Regulatory stage ──────────────────────────────────────────────────────
  const pApprovalGivenSuccess = REG_APPROVAL_PROB[inputs.regulatoryContext] ?? 0.85;
  const regCostM  = inputs.regCostM ?? 1.0;
  const reviewMonths = REVIEW_MONTHS_BY_REG_CONTEXT[inputs.regulatoryContext] ?? 12;
  const regStage: RegStage = {
    costM:              regCostM,
    pApproval:          pApprovalGivenSuccess,
    regulatoryContext:  inputs.regulatoryContext,
    pPriorSuccess:      cumPriorSuccess,
    riskAdjCostM:       regCostM * cumPriorSuccess,
    reviewMonths,
  };

  // ── Summary ───────────────────────────────────────────────────────────────
  const pAllTrialsSuccess  = cumPriorSuccess;
  const pApproval          = pAllTrialsSuccess * pApprovalGivenSuccess;

  const totalNominalCostM  = stages.reduce((s, st) => s + st.trialCostM, 0) + regCostM;
  const totalRiskAdjCostM  = stages.reduce((s, st) => s + st.riskAdjCostM, 0) + regStage.riskAdjCostM;
  const totalDurationMonths = stages.reduce((s, st) => s + st.durationMonths, 0) + regStage.reviewMonths;

  const eNPVM = round1(pApproval * revenuePVM - totalRiskAdjCostM);
  const eROI  = totalRiskAdjCostM > 0.1 ? round2(eNPVM / totalRiskAdjCostM) : null;

  return {
    stages,
    regStage,
    pAllTrialsSuccess,
    pApproval,
    totalNominalCostM,
    totalRiskAdjCostM,
    totalDurationMonths,
    revenuePVM,
    eNPVM,
    eROI,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function round1(x: number)  { return Math.round(x * 10) / 10; }
function round2(x: number)  { return Math.round(x * 100) / 100; }
