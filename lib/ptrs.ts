// ─── Unified Approval Probability Engine ──────────────────────────────────────
//
// computeApprovalProbability() is the single authoritative entry point for
// computing P(approval) for a drug asset.
//
// Architecture:
//   Layer 1  — Mechanism scoring (ptrs-mechanism-scorer.ts)
//              Inputs: drug name, mechanism, indication, preclinical data
//              Outputs: MSS, σ², IPS, TRS (prior on drug effect distribution)
//
//   Layer 2  — Trial design simulation per stage (ptrs-trial.ts)
//              Inputs: MSS, σ² entering stage + trial design parameters
//              Outputs: Φ(z) = P(this trial detects effect) + Bayesian posterior
//
//   Dev Plan — Stage-by-stage path (dev-plan.ts)
//              Runs Layer 2 for each stage, applies Bayesian updates,
//              multiplies P(stage success) values to get cumulative P(approval)
//
// This function is a thin wrapper around computeDevPlan() that:
//   a) exposes a clean, named probability API
//   b) strips out cost/eNPV outputs (used by cashflow.ts separately)
//   c) makes the unified engine importable without the full DevPlanResult type
//
// Usage:
//   1. Run /api/ptrs-score    → get { mss, variance, ciHalfWidth }
//   2. Run /api/effect-prior  → get { effectPrior: { mixture, ... } } (or fall
//      back to mixtureFromMssVariance(mss, variance) if not yet available)
//   3. Run /api/dev-plan      → get { stages: DevStageInput[], regulatoryContext }
//   4. Call computeApprovalProbability(mixture, ciHalfWidth, stages, regContext)
//      → returns P(approval) and stage breakdown
//
// ─────────────────────────────────────────────────────────────────────────────

import { computeDevPlan } from "./dev-plan";
import type { DevStageInput } from "./dev-plan";
import type { RegulatoryContext } from "./ptrs-trial";
import type { EffectPriorMixture } from "./effect-prior";

// ─── Output type ──────────────────────────────────────────────────────────────

export type ApprovalProbResult = {
  // The single unified P(approval) number
  pApproval: number;

  // Breakdown for transparency
  pAllTrials: number;    // cumulative P(all clinical stages succeed)
  pReg: number;          // P(approval | all trials succeed)

  // Per-stage detail
  stages: Array<{
    name: string;
    phase: string;
    pStage: number;       // P(this individual trial succeeds) = Φ(z)
    cumP: number;         // cumulative P through this stage
    mssInput: number;     // MSS entering this stage
    mssIfSuccess: number; // Bayesian MSS update if this stage succeeds
  }>;
};

// ─── Main function ─────────────────────────────────────────────────────────────

export function computeApprovalProbability(
  mixture: EffectPriorMixture,
  ciHalfWidth: number,
  stages: DevStageInput[],
  regulatoryContext: RegulatoryContext,
): ApprovalProbResult {
  // Delegate all computation to computeDevPlan (the full engine).
  // Revenue = 0 because we only want the probability outputs here;
  // eNPV is computed separately in cashflow.ts with the revenue model.
  const plan = computeDevPlan(
    mixture,
    ciHalfWidth,
    { stages, regulatoryContext },
    0, // revenuePVM = 0, we don't need eNPV here
  );

  return {
    pApproval:  plan.pApproval,
    pAllTrials: plan.pAllTrialsSuccess,
    pReg:       plan.regStage.pApproval,
    stages: plan.stages.map((s) => ({
      name:          s.name,
      phase:         s.phase,
      pStage:        s.trialSuccessProb,
      cumP:          s.cumSuccessProb,
      mssInput:      s.mssInput,
      mssIfSuccess:  s.mssIfSuccess,
    })),
  };
}
