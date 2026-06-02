// ─── Development Plan Engine ──────────────────────────────────────────────────
//
// Models the full remaining development path as a sequence of discrete trial
// stages, each with its own probability, cost, and Bayesian drug-truth update.
//
// Core logic:
//   1. Each stage runs Layer 2 scoreLayer2() with its specific trial design
//      to get P(trial succeeds | drug is real).
//   2. After each successful trial, MSS (drug truth) is updated upward
//      (Bayesian posterior) and variance decreases (we know more).
//   3. Costs are risk-adjusted: each trial cost × P(all prior stages succeeded).
//      → Phase 2: paid in full (already committed)
//      → Phase 3: × P(Phase 2 success)
//      → Reg: × P(Phase 2) × P(Phase 3)
//   4. eNPV = P(approval) × Revenue PV − total risk-adjusted cost
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

// ─── Bayesian MSS update tables ───────────────────────────────────────────────
//
// When a trial succeeds, we gain information that the drug works.
// The MSS (mechanism signal strength) increases by an uplift amount,
// and variance decreases (we know more).
//
// Uplift is larger for harder endpoints (more confirmatory) and smaller
// for soft endpoints (could be noise).

const MSS_UPLIFT_BY_ENDPOINT: Record<EndpointType, number> = {
  hard:      0.15,   // OS, CR confirmed — strong mechanistic confirmation
  surrogate: 0.10,   // PFS, ORR, BCVA — moderate confirmation
  pro:       0.06,   // subjective — weak confirmation, could be noise
};

// Each successful trial reduces variance by this fraction
// (uncertainty shrinks as evidence accumulates)
const VARIANCE_REDUCTION = 0.65;

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
};

// Computed result for one stage
export type DevStage = DevStageInput & {
  // Drug truth going into this stage
  mssInput: number;
  varianceInput: number;
  ptrsLayer1Input: number;  // phase baseline + mechanism adjustment given mssInput

  // Layer 2 result
  trialSuccessProb: number; // Φ(z) — P(this trial detects effect)
  layer2Multiplier: number;
  sigma2Trial: number;
  riskFlags: TrialRiskFlag[];

  // Drug truth if this stage succeeds (Bayesian posterior)
  mssIfSuccess: number;
  varianceIfSuccess: number;

  // Cost accounting
  trialCostM: number;          // n × cpp / 1e6
  pPriorSuccess: number;       // P(all prior stages succeeded) — cost multiplier
  riskAdjCostM: number;        // trialCostM × pPriorSuccess

  // Cumulative probability through this stage
  cumSuccessProb: number;      // pPriorSuccess × trialSuccessProb
};

export type RegStage = {
  costM: number;               // fixed regulatory cost (default $1M)
  pApproval: number;           // P(approval | all trials succeed)
  regulatoryContext: RegulatoryContext;
  pPriorSuccess: number;       // P(all clinical trials succeeded)
  riskAdjCostM: number;        // costM × pPriorSuccess
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

// ─── Core computation ─────────────────────────────────────────────────────────

export function computeDevPlan(
  // Current drug truth (from Layer 1 PTRS result)
  mss: number,
  variance: number,
  ciHalfWidth: number,
  // Plan definition
  inputs: DevPlanInputs,
  // Revenue (from existing valuation)
  revenuePVM: number,
): DevPlanResult {

  const stages: DevStage[] = [];
  let currentMSS      = mss;
  let currentVariance = variance;
  let cumPriorSuccess = 1.0; // P(all prior stages succeeded); starts at 1 (nothing has failed yet)

  for (const stageInput of inputs.stages) {

    // ── Derive ptrsLayer1 for this stage's phase ─────────────────────────────
    // Phase baseline + asymmetric mechanism adjustment (same formula as
    // ptrs-mechanism-scorer.ts scoreMechanism → ptrsAdjustment)
    const phaseBase = PHASE_BASELINE[stageInput.phase] ?? 0.25;
    const mechAdj = currentMSS >= 0.5
      ? Math.min((currentMSS - 0.5) * 0.55, 0.20)
      : Math.max((currentMSS - 0.5) * 0.30, -0.15);
    const ptrsLayer1 = clamp01(phaseBase + mechAdj);

    // ── Layer 2: trial-specific success probability ───────────────────────────
    const l2 = scoreLayer2(
      currentMSS,
      currentVariance,
      ptrsLayer1,
      ciHalfWidth,
      stageInput.trialDesign,
    );

    // trialSuccessProb = Φ(z) = P(this trial detects the effect)
    // This is the per-stage probability, not the compound approval probability.
    const trialSuccessProb = l2.trialSuccessProb;

    // ── Bayesian update: drug truth if this stage succeeds ────────────────────
    // Positive trial = confirmation. MSS shifts toward 1, variance shrinks.
    // Uplift depends on endpoint quality (how informative is a positive result).
    const uplift = MSS_UPLIFT_BY_ENDPOINT[stageInput.trialDesign.endpointType] ?? 0.10;
    const mssIfSuccess      = Math.min(0.95, currentMSS + uplift);
    const varianceIfSuccess = currentVariance * VARIANCE_REDUCTION;

    // ── Cost accounting ───────────────────────────────────────────────────────
    const trialCostM   = (stageInput.n * stageInput.cpp) / 1e6;
    // Risk-adjusted: this trial only happens if all prior stages succeeded
    const riskAdjCostM = trialCostM * cumPriorSuccess;
    // Cumulative probability through this stage
    const cumSuccessProb = cumPriorSuccess * trialSuccessProb;

    stages.push({
      ...stageInput,
      mssInput:          currentMSS,
      varianceInput:     currentVariance,
      ptrsLayer1Input:   ptrsLayer1,
      trialSuccessProb,
      layer2Multiplier:  l2.layer2Multiplier,
      sigma2Trial:       l2.sigma2Trial,
      riskFlags:         l2.riskFlags,
      mssIfSuccess,
      varianceIfSuccess,
      trialCostM,
      pPriorSuccess:     cumPriorSuccess,
      riskAdjCostM,
      cumSuccessProb,
    });

    // Advance drug truth for next stage: assume this stage succeeds
    currentMSS      = mssIfSuccess;
    currentVariance = varianceIfSuccess;
    cumPriorSuccess = cumSuccessProb;
  }

  // ── Regulatory stage ──────────────────────────────────────────────────────
  const pApprovalGivenSuccess = REG_APPROVAL_PROB[inputs.regulatoryContext] ?? 0.85;
  const regCostM  = inputs.regCostM ?? 1.0;
  const regStage: RegStage = {
    costM:              regCostM,
    pApproval:          pApprovalGivenSuccess,
    regulatoryContext:  inputs.regulatoryContext,
    pPriorSuccess:      cumPriorSuccess,
    riskAdjCostM:       regCostM * cumPriorSuccess,
  };

  // ── Summary ───────────────────────────────────────────────────────────────
  const pAllTrialsSuccess  = cumPriorSuccess;
  const pApproval          = pAllTrialsSuccess * pApprovalGivenSuccess;

  const totalNominalCostM  = stages.reduce((s, st) => s + st.trialCostM, 0) + regCostM;
  const totalRiskAdjCostM  = stages.reduce((s, st) => s + st.riskAdjCostM, 0) + regStage.riskAdjCostM;

  const eNPVM = round1(pApproval * revenuePVM - totalRiskAdjCostM);
  const eROI  = totalRiskAdjCostM > 0.1 ? round2(eNPVM / totalRiskAdjCostM) : null;

  return {
    stages,
    regStage,
    pAllTrialsSuccess,
    pApproval,
    totalNominalCostM,
    totalRiskAdjCostM,
    revenuePVM,
    eNPVM,
    eROI,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function round1(x: number)  { return Math.round(x * 10) / 10; }
function round2(x: number)  { return Math.round(x * 100) / 100; }
