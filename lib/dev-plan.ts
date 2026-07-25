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
import { mixtureMoments, type EffectPriorMixture, type ClassStatus } from "./effect-prior";
import { pinCostPerPatient, type TherapeuticArea } from "./financial-pins";
import { graveyardHaircut } from "./class-risk";
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
//
// DEBT (Build 3): this is the FLAT per-designation base rate and it governs the BASE
// path (and the FROZEN tripwires — TTX 0.09993 / tau 0.26751 both embed 0.85). The
// SCENARIO axis derives regulatory confidence from evidence via deriveRegConfidence()
// below, which USES these values as its base rate and adjusts for endpoint acceptability.
// Two representations of one quantity (flat base rate vs evidence-derived); making the
// base path evidence-derived is a re-pin queued WITH the POP_N_FACTOR retirement — do NOT
// change these values or the base-path lookup here.
const REG_APPROVAL_PROB: Record<RegulatoryContext, number> = {
  standard:      0.85,
  fast_track:    0.85,  // Fast Track does NOT raise the approval probability (== standard)
  btd:           0.92,
  orphan:        0.90,
  btd_orphan:    0.94,
  accelerated:   0.88,
  confirmatory:  0.95,
};

// ─── Evidence-derived regulatory confidence (graded, scenario-only) ──────────────
// P(approve | trials succeeded) derived from the dossier's regulatory ACCEPTABILITY —
// not a flat per-designation constant. It IS the conditional approval probability the
// reg gate multiplies (pApproval = pAllTrials × this), computed from evidence, NOT a
// bolt-on output multiplier.
//   • designation base rate = REG_APPROVAL_PROB[designation] (grounded; preserved).
//   • endpoint ACCEPTABILITY = a GRADED 4-level scale, each level RESOLVED from an
//     OBSERVABLE (FDA guidance for this endpoint? prior full approvals on it?
//     accelerated-only precedent? approved-in-class on it?) — never vibe-picked. An
//     endpoint with no resolvable precedent falls to L4 AND is FLAGGED, never silently
//     placed mid-scale (same searched-or-flagged discipline as designations).
//
// ENDPOINT DOUBLE-COUNT SEPARATION: this endpoint term is ACCEPTABILITY — "will the agency
// accept this endpoint as an approval basis even if the trial hits it." It is the ONLY
// categorical endpoint rule left. Its trial-P sibling (bayesian-rr ENDPOINT_N_FACTOR) was
// DELETED in the endpoint-semantics pass — endpoint now moves TRIAL P only through
// quantitative params (n, nullRR, comparatorSigma2, design, isTimeToEvent, prior). So
// acceptability (here) and achievability (the sim) can never book the same fact, and there
// is no longer a categorical trial-P term for this to collide with.
//
// Endpoint-precedent observables used HERE (guidance / approvals-on-this-endpoint) are the
// endpoint's regulatory acceptability — distinct from analog-TARGET precedent
// (approvedInClass as a target signal), which moves the Build-2 effect prior + modality
// haircut, not this gate. Safety is deferred (no signal).
// GROUNDED/BOUNDED: per-level deltas are named constants pinned to regulatory precedent,
// clamped to [FLOOR, CAP] so weak evidence can't manufacture a high approval prob. NOT a
// target P. Build-3 anchors preserved: L1 = +HARD_BONUS, L2 = 0, L4 = −INFERRED_PENALTY.
const REG_ENDPOINT_HARD_BONUS = 0.03;                 // L1 precedented clinical outcome — agency-preferred basis
const REG_ACCEPTANCE_THIN_PENALTY = 0.06;             // L3 accelerated-only precedent — real but confirmatory-verify risk (~½ the novel penalty)
const REG_ENDPOINT_SURROGATE_INFERRED_PENALTY = 0.12; // L4 no-precedent / novel surrogate — full penalty (flagged)
const REG_CONFIDENCE_FLOOR = 0.50;
const REG_CONFIDENCE_CAP = 0.97;

// The 4-level graded regulatory-acceptance scale. Deltas apply on top of the designation
// base rate; L1 > L2 > L3 > L4 by construction. L4 is FLAGGED at resolution time.
export type RegAcceptanceLevel =
  | "L1_precedented_outcome"    // hard clinical outcome (OS, CR, organ function) — agency-preferred
  | "L2_validated_surrogate"    // FDA guidance accepts it OR ≥1 full in-class approval on it
  | "L3_thin_precedent"         // only accelerated-approval precedent on it (confirmation pending)
  | "L4_no_precedent";          // no guidance, no approvals — novel/speculative → FLAGGED
const REG_ACCEPTANCE_DELTA: Record<RegAcceptanceLevel, number> = {
  L1_precedented_outcome:  REG_ENDPOINT_HARD_BONUS,
  L2_validated_surrogate:  0,
  L3_thin_precedent:      -REG_ACCEPTANCE_THIN_PENALTY,
  L4_no_precedent:        -REG_ENDPOINT_SURROGATE_INFERRED_PENALTY,
};

// Observables the acceptance level is RESOLVED from. Emitted by the generators
// (searched-or-flagged), never guessed. endpointEvidenceBasis is the back-compat
// resolved-or-flagged signal used when the richer observables are absent.
export type RegAcceptanceObservables = {
  endpointType: EndpointType;
  fdaGuidanceForEndpoint?: boolean;                              // FDA guidance endorses THIS endpoint as an approval basis
  priorFullApprovalsOnEndpoint?: "none" | "one_or_two" | "many"; // full (non-accelerated) approvals on THIS endpoint
  acceleratedOnlyPrecedent?: boolean;                            // approvals on it exist ONLY via accelerated (confirm pending)
  approvedInClassOnEndpoint?: boolean;                           // an in-class agent was approved on this endpoint
  endpointEvidenceBasis?: "CONFIRMED" | "INFERRED";              // back-compat signal when richer observables absent
};

// RESOLVE observables → level (+ flagged). Never silently returns L2/L3 when unconfirmable:
// a surrogate with no resolvable precedent falls to L4 AND is flagged.
export function resolveRegAcceptanceLevel(
  obs: RegAcceptanceObservables,
): { level: RegAcceptanceLevel; flagged: boolean } {
  // L1: a hard clinical-outcome endpoint is the agency-preferred approval basis.
  if (obs.endpointType === "hard") return { level: "L1_precedented_outcome", flagged: false };

  // Surrogate / PRO: resolve acceptability from precedent observables.
  const validated =
    obs.fdaGuidanceForEndpoint === true ||
    obs.priorFullApprovalsOnEndpoint === "many" ||
    obs.priorFullApprovalsOnEndpoint === "one_or_two" ||
    obs.approvedInClassOnEndpoint === true;
  if (validated) return { level: "L2_validated_surrogate", flagged: false };

  // Only accelerated-approval precedent → real but conditional acceptance.
  if (obs.acceleratedOnlyPrecedent === true) return { level: "L3_thin_precedent", flagged: false };

  // Back-compat: an explicit CONFIRMED (FDA-accepted) basis with no richer observables
  // maps to a validated surrogate; INFERRED / unset falls through to the flagged floor.
  if (obs.endpointEvidenceBasis === "CONFIRMED") return { level: "L2_validated_surrogate", flagged: false };

  // No resolvable precedent (or unconfirmable) → conservative L4, FLAGGED (never silent L2/L3).
  return { level: "L4_no_precedent", flagged: true };
}

export function deriveRegConfidence(opts: {
  designation: RegulatoryContext;
  endpointType: EndpointType;
  endpointEvidenceBasis?: "CONFIRMED" | "INFERRED";
  regAcceptance?: RegAcceptanceObservables; // richer observables; falls back to endpointType/basis
}): number {
  const base = REG_APPROVAL_PROB[opts.designation] ?? 0.85; // grounded designation base rate (preserved)
  const obs: RegAcceptanceObservables = opts.regAcceptance ?? {
    endpointType: opts.endpointType,
    endpointEvidenceBasis: opts.endpointEvidenceBasis,
  };
  const { level } = resolveRegAcceptanceLevel(obs);
  const delta = REG_ACCEPTANCE_DELTA[level];
  return Math.max(REG_CONFIDENCE_FLOOR, Math.min(REG_CONFIDENCE_CAP, base + delta));
}

// ─── Regulatory review timeline ───────────────────────────────────────────────
// Typical FDA review duration (months), submission to decision, by pathway.
const REVIEW_MONTHS_BY_REG_CONTEXT: Record<RegulatoryContext, number> = {
  standard:      12,
  fast_track:    10,  // rolling review shortens submission-to-decision (timeline ONLY, not probability)
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
  completionDate?: string;        // current trial only: CT.gov primary-completion date (ISO).
                                  //   For a FULLY ENROLLED trial this is the ground-truth
                                  //   readout date → remaining duration = months-to-completion,
                                  //   overriding the projected enroll/obs/startup estimate.
  enrollmentComplete?: boolean;   // current trial only: CT.gov says fully enrolled
                                  //   (Active-not-recruiting / Completed / Enrolling-
                                  //   by-invitation) → accrual is elapsed, so it adds
                                  //   ~0 remaining enrollment time to the launch model

  // Bayesian RR engine inputs (AI-estimated or user-entered)
  nullResponseRate?: number;      // SOC/historical control response rate (0-1)
  observedResponseRate?: number;  // actual observed RR from a completed trial
  observedN?: number;             // n for the observed result
  isTimeToEvent?: boolean;        // true = OS/PFS/DFS endpoint, approximated via RR proxy
  comparatorSigma2?: number;      // variance of the historical control estimate
                                  //   0 for RCTs (control measured in-trial)
                                  //   >0 for single-arm vs uncertain historical benchmark
  comparatorSource?: string;      // where the comparator rate comes from (for display)

  // Endpoint transparency
  endpointRationale?: string;            // plain-language: why this endpoint for this stage
  endpointEvidenceBasis?: "CONFIRMED" | "INFERRED"; // confirmed by company vs FDA precedent/inference
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
  trialSuccessProb: number; // final — after base-rate ceiling AND modality haircut
  trialSuccessProbRaw: number; // raw integral, before ceiling or haircut
  successCeilingBound: number | null; // the base-rate ceiling that clamped this stage, if any
  modalityHaircut: number;     // 1.0 = none; <1 = class-graveyard haircut applied to this stage
  layer2Multiplier: number;
  sigma2Trial: number;
  riskFlags: TrialRiskFlag[];

  // Drug truth if this stage succeeds (Bayesian posterior, derived from mixtureIfSuccess)
  mssIfSuccess: number;
  varianceIfSuccess: number;

  // Cost accounting (cpp is the PINNED benchmark value — displayed == used; see Fix #2)
  cppRaw: number;              // the LLM-suggested cost-per-patient before pinning
  cppClamped: boolean;         // true if the LLM cpp fell outside the benchmark band
  cppProvenance: string;       // "pinned: <TA> <phase> $Xk" (+ band note if clamped)
  trialCostM: number;          // n × (pinned cpp) / 1e6
  pPriorSuccess: number;       // P(all prior stages succeeded) — cost multiplier
  riskAdjCostM: number;        // trialCostM × pPriorSuccess

  // Timeline (months) — unit-normalized + sanity-bounded (see normalizeDurationMonths).
  // The stage's treatmentObsMonths / startupCushionMonths values ARE the normalized
  // ones (displayed == used); the *Raw fields preserve what the LLM returned.
  enrollmentMonths: number;      // remaining accrual time (0 if current trial fully enrolled)
  enrollmentMonthsRaw: number;   // n / enrollmentRatePerMonth, before bounds
  enrollmentComplete: boolean;   // current trial already fully enrolled → 0 remaining accrual
  enrollmentClamped: boolean;    // future accrual clamped to the phase ceiling
  treatmentObsMonthsRaw: number; // obs value as returned, before normalization
  treatmentObsWasWeeks: boolean; // obs value was a week-count, converted to months
  treatmentObsClamped: boolean;  // obs value clamped to MAX_TREATMENT_OBS_MONTHS
  startupCushionMonthsRaw: number;
  durationFromCompletion: boolean; // true = duration is remaining months to the trial's
                                   //   CT.gov completion date (fully-enrolled current trial),
                                   //   overriding the enroll+obs+startup sum
  durationMonths: number;        // enrollmentMonths + treatmentObsMonths + startupCushionMonths
                                 //   (or months-to-completion when durationFromCompletion)

  // Cumulative probability through this stage
  cumSuccessProb: number;      // pPriorSuccess × trialSuccessProb

  // ── Bayesian RR diagnostics (from lib/bayesian-rr.ts) ──
  rrPriorGrid?: { theta: number[]; density: number[] };     // downsampled ~60 pts for UI
  rrPosteriorGrid?: { theta: number[]; density: number[] }; // downsampled ~60 pts for UI
  bandsBefore?: RRBands;
  bandsAfter?: RRBands;
  nullResponseRate: number;
  isProxied?: boolean;           // true if TTE endpoint approximated via RR proxy
  comparatorUnreliable?: boolean; // un-pinned comparator exceeded the drug's own prior mean →
                                  //   discarded, held to clinical floor (data-quality flag; fix #3)
  comparatorGrid?: { theta: number[]; density: number[] } | null; // comparator density for chart
  comparatorSigma2Effective: number; // actual comparatorSigma2 used in computation
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
  impliedLaunchYear: number;   // calendar year of approval: now + totalDurationMonths

  // Value outputs
  revenuePVM: number;          // from base context
  eNPVM: number;               // pApproval × revenuePVM − totalRiskAdjCostM
  eROI: number | null;         // eNPVM / totalRiskAdjCostM

  // Echoed so downstream (decision-analysis per-option plans) applies the same haircut
  modalityClassStatus?: ClassStatus;
  // Part 2: the blended p_graveyard actually used for the haircut (echoed for UI/audit).
  classGraveyardProbability?: number;
  // Fix B: true when an orphan/btd_orphan context was downgraded for engine purposes
  // because it wasn't confirmed for the base-case indication (audit/UI signal).
  orphanGatedOff?: boolean;
};

// Inputs for the full plan computation
export type DevPlanInputs = {
  stages: DevStageInput[];
  regulatoryContext: RegulatoryContext; // drives reg approval probability
  regCostM?: number;                   // override default $1M
  // Modality/target-class status from the analog step (Step 3). "graveyard"
  // applies the modality meta-risk haircut to trial-success stages.
  modalityClassStatus?: ClassStatus;
  // Part 2: deterministic P(class is a graveyard) ∈ [0,1] from the class-risk rule
  // (class-risk.ts). When present it drives the haircut as a BLEND (1−0.20·p);
  // when absent the binary modalityClassStatus is used (backward-compatible).
  classGraveyardProbability?: number;
  therapeuticArea?: TherapeuticArea; // Fix #2: keys the pinned cost-per-patient benchmark
  // Fix B: orphan designation only earns engine benefits (easier significance bar +
  // reg-approval uplift) if it is confirmed FOR THE BASE-CASE INDICATION. Default-deny:
  // when undefined/false, an "orphan"/"btd_orphan" context is downgraded for engine
  // purposes so an unearned cross-indication designation can't inflate P(approval).
  orphanConfirmedForIndication?: boolean;
  // SCENARIO-ONLY: when present, the reg gate resolves the graded acceptance level over
  // this registration endpoint (evidence-derived P(approve|success)) instead of the flat
  // REG_APPROVAL_PROB lookup. Absent (base path) → flat lookup → FROZEN byte-identical.
  // Carries the full acceptance observables (RegAcceptanceObservables); endpointType +
  // endpointEvidenceBasis alone remain a valid subset (back-compat).
  regEndpoint?: RegAcceptanceObservables;
};

// Default null/control response rates by phase (when AI doesn't provide one)
const DEFAULT_NULL_RR: Record<string, number> = {
  "Preclinical": 0.05,
  "Phase 1":     0.10,
  "Phase 2":     0.15,
  "Phase 3":     0.20,
  "Filed":       0.20,
};

/**
 * Calendar year in which approval (≈ launch) lands if the remaining
 * development pathway starts now and takes totalDurationMonths
 * (all trial stages + regulatory review).
 */
export function impliedLaunchYear(totalDurationMonths: number, asOf: Date = new Date()): number {
  const d = new Date(asOf.getTime());
  d.setMonth(d.getMonth() + Math.round(totalDurationMonths));
  return d.getFullYear();
}

/**
 * How the LOE year responds when the launch year moves.
 *
 * - "exclusivity" basis (BPCIA floor, launch+exclusivity estimate): the LOE is
 *   anchored to approval/launch, so it slides to launchYear + exclusivityYears.
 * - "patent" basis (Orange Book / patent analysis) and manual entries are
 *   calendar-fixed — a later launch compresses the revenue window.
 * - Either way, if launch reaches or passes the stored LOE, the patents are
 *   moot: FDA regulatory exclusivity from approval becomes the binding
 *   constraint, so LOE resets to launchYear + exclusivityYears.
 */
export function shiftLoeForLaunch(
  loeYear: number | undefined,
  loeBasis: "patent" | "exclusivity" | undefined,
  launchYear: number,
  exclusivityYears: number = 8,
): number | undefined {
  if (loeYear == null) return loeYear;
  if (loeBasis === "exclusivity" || launchYear >= loeYear) {
    return launchYear + exclusivityYears;
  }
  return loeYear;
}

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
  let prevStage: DevStageInput | null = null;

  // Fix B: orphan benefits (easier significance bar + reg-approval uplift) apply only
  // when the orphan designation is confirmed for the base-case indication. Default-deny.
  const orphanConfirmed = inputs.orphanConfirmedForIndication === true;
  const isOrphanCtx = (c: RegulatoryContext) => c === "orphan" || c === "btd_orphan";
  const orphanGatedOff = !orphanConfirmed &&
    (isOrphanCtx(inputs.regulatoryContext) || inputs.stages.some((s) => isOrphanCtx(s.trialDesign.regulatoryContext)));

  for (const stageInput of inputs.stages) {

    // ── Surrogate-translation penalty (Part 4) ────────────────────────────────
    // If the previous stage gated on a RATE surrogate (e.g. ctDNA clearance) and
    // THIS stage gates on a harder time-to-event endpoint (e.g. RFS), the
    // molecular-surrogate → clinical-endpoint link is not fully validated in this
    // setting. Widen the incoming prior's variance so a low-information surrogate
    // win does NOT fully de-risk the hard-endpoint trial. Additive penalty,
    // analogous to the cross-setting penalty in the own-clinical evidence step.
    if (prevStage && prevStage.isTimeToEvent === false && stageInput.isTimeToEvent === true) {
      currentMixture = addMixtureVariance(currentMixture, SURROGATE_TRANSLATION_SIGMA2);
    }

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
      // Fix B: gate the orphan significance-bar benefit on indication-confirmation.
      regulatoryContext: gateOrphanForEngine(stageInput.trialDesign.regulatoryContext, orphanConfirmed),
    };

    const rrResult = computeStageRR(
      currentMixture,
      stageInput.n,
      nullRR,
      rrDesign,
      stageInput.isTimeToEvent === true,
      stageInput.observedResponseRate,
      stageInput.observedN,
      stageInput.comparatorSigma2 ?? 0,
    );

    const trialSuccessProbRaw = rrResult.trialSuccessProb;

    // ── Base-rate ceilings (Part B) — GENERAL, all assets, applied before the
    //    class haircut. Decouples statistical DETECTION from clinical SUCCESS.
    // A tight comparator / large n raises the power to DETECT a difference, but
    // detection is not success — no trial's outcome is near-certain (execution,
    // safety halts, an effect that isn't real). Cap any single stage (general
    // ceiling), and cap a CONFIRMATORY (Phase 3 / pivotal) stage lower to reflect
    // the documented Phase-3 base-rate failure hazard (effect-size shrinkage /
    // winner's curse, population broadening, replication) that persists even after
    // a positive earlier stage. NOT class-conditioned, NOT tuned to any expectation.
    const isConfirmatory = /3|registration|pivotal/i.test(stageInput.phase);
    const successCeiling = isConfirmatory ? LATE_PHASE_SUCCESS_CEILING : STAGE_SUCCESS_CEILING;
    const cappedTrialSuccessProb = Math.min(trialSuccessProbRaw, successCeiling);
    const successCeilingBound = cappedTrialSuccessProb < trialSuccessProbRaw ? successCeiling : null;

    // ── Modality meta-risk haircut (class base rate on the GATE) ──────────────
    // The effect prior already carries the class-graveyard signal on effect SIZE
    // (analog step). This is a DISTINCT quantity: given whatever effect the drug
    // has, a modality class with zero approvals and a documented failure pattern
    // (fatal tox terminations, delivery failures, PD-not-translating) is less
    // likely to CLEAR each efficacy gate than the drug's own per-stage evidence
    // implies. Applied to trial-success stages only (not reg, not the prior), it
    // compounds across the multi-gate path — a graveyard modality is more likely
    // to fail SOMEWHERE. Not double-counting: prior = effect size; haircut =
    // gate-completion odds given that effect (tolerability/translation/execution).
    // Class base-rate risk as a deterministic BLEND over p_graveyard (Part 2):
    // graveyard-certain → full haircut, validated → none, genuinely-split → the
    // weighted value between — so the haircut stops flipping with a coin-flip
    // graveyard/mixed LABEL. p_graveyard comes from the deterministic class-risk
    // rule (class-risk.ts, fed by structured analog facts). Falls back to the
    // binary label when no probability is supplied, preserving prior behavior
    // exactly (graveyard → 0.80, else 1.0). The stage-success FORMULA is unchanged;
    // only how modalityHaircut is derived changed.
    const pGraveyard = inputs.classGraveyardProbability
      ?? (inputs.modalityClassStatus === "graveyard" ? 1 : 0);
    const modalityHaircut = graveyardHaircut(pGraveyard, MODALITY_META_RISK_HAIRCUT);
    const trialSuccessProb = clamp01(cappedTrialSuccessProb * modalityHaircut);

    // Convert the posterior grid back to a Gaussian mixture for the next stage
    const mixtureIfSuccess = gridToGaussianMixture(
      rrResult.posteriorGrid,
      currentMixture.length,
    );
    const { mss: mssIfSuccess, variance: varianceIfSuccess } = mixtureMoments(mixtureIfSuccess);

    // ── Cost accounting (Fix #2: cost-per-patient pinned to phase × TA benchmark) ─
    // The pinned central value GOVERNS so identical assets stop swinging on cost;
    // this touches only dollar cost, never any probability.
    const cppPin = pinCostPerPatient(stageInput.phase, inputs.therapeuticArea, {
      populationType:    stageInput.trialDesign.populationType,
      regulatoryContext: stageInput.trialDesign.regulatoryContext,
      llmCpp:            stageInput.cpp,
    });
    const trialCostM   = (stageInput.n * cppPin.cpp) / 1e6;
    // Risk-adjusted: this trial only happens if all prior stages succeeded
    const riskAdjCostM = trialCostM * cumPriorSuccess;
    // Cumulative probability through this stage
    const cumSuccessProb = cumPriorSuccess * trialSuccessProb;

    // ── Timeline (unit-normalized + sanity-bounded) ─────────────────────────────
    // Corrects the two non-credible-duration failure modes: (1) a week-count dropped
    // into a month field (obs of 76 → ~18mo), and (2) an absurd accrual projection —
    // a fully-enrolled current trial adds ~0 future enrollment, and a future stage
    // cannot accrue beyond its phase ceiling. Timeline only; no probability depends
    // on any duration.
    const obs     = normalizeDurationMonths(stageInput.treatmentObsMonths, MAX_TREATMENT_OBS_MONTHS);
    const startup = normalizeDurationMonths(stageInput.startupCushionMonths, MAX_STARTUP_MONTHS);

    const enrollmentMonthsRaw = stageInput.n / Math.max(stageInput.enrollmentRatePerMonth, 0.1);
    let enrollmentMonths = enrollmentMonthsRaw;
    let enrollmentComplete = false;
    let enrollmentClamped = false;
    if (stageInput.isCurrentTrial && stageInput.enrollmentComplete) {
      enrollmentMonths = 0; // already fully enrolled: accrual is elapsed, not remaining
      enrollmentComplete = true;
    } else {
      const enrollCeiling = maxEnrollmentMonths(stageInput.phase);
      if (enrollmentMonths > enrollCeiling) { enrollmentMonths = enrollCeiling; enrollmentClamped = true; }
    }

    // A FULLY ENROLLED current trial with a known CT.gov completion date has a
    // GROUND-TRUTH remaining duration = months from now to that readout — use it
    // instead of the projected enroll+obs+startup estimate (which over-counts an
    // already-running trial). General: any fully-enrolled trial with a completion
    // date. Clamped to the credible max so a stale/far-future date can't blow up the
    // timeline; floored at a short readout residual so a just-past date isn't zero.
    let durationFromCompletion = false;
    let durationMonths = enrollmentMonths + obs.months + startup.months;
    if (enrollmentComplete && stageInput.completionDate) {
      const compMs = Date.parse(stageInput.completionDate);
      if (!Number.isNaN(compMs)) {
        const nowD = new Date();
        const compD = new Date(compMs);
        // UTC month arithmetic so the remaining duration is identical on a UTC server
        // (Vercel) and a dev box in any timezone — no environment-dependent off-by-one.
        const monthsToCompletion =
          (compD.getUTCFullYear() - nowD.getUTCFullYear()) * 12 + (compD.getUTCMonth() - nowD.getUTCMonth());
        // Cap at MAX_TREATMENT_OBS_MONTHS (a fully-enrolled readout ≤ ~3y remaining);
        // floor at 3mo (a just-completed trial still needs analysis/readout).
        durationMonths = Math.min(MAX_TREATMENT_OBS_MONTHS, Math.max(3, monthsToCompletion));
        durationFromCompletion = true;
      }
    }

    stages.push({
      ...stageInput,
      mssInput:          currentMSS,
      varianceInput:     currentVariance,
      ptrsLayer1Input:   ptrsLayer1,
      mixtureInput:      currentMixture,
      mixtureIfSuccess,
      trialSuccessProb,
      trialSuccessProbRaw,
      successCeilingBound,
      modalityHaircut,
      layer2Multiplier:  l2.layer2Multiplier,
      sigma2Trial:       l2.sigma2Trial,
      riskFlags:         l2.riskFlags,
      mssIfSuccess,
      varianceIfSuccess,
      cpp:               cppPin.cpp,   // pinned benchmark value overwrites the raw stageInput.cpp
      cppRaw:            cppPin.raw ?? stageInput.cpp,
      cppClamped:        cppPin.clamped,
      cppProvenance:     cppPin.provenance,
      trialCostM,
      pPriorSuccess:     cumPriorSuccess,
      riskAdjCostM,
      // Timeline — normalized values overwrite the raw stageInput fields (displayed == used)
      enrollmentMonths,
      enrollmentMonthsRaw,
      enrollmentComplete,
      enrollmentClamped,
      treatmentObsMonths:      obs.months,
      treatmentObsMonthsRaw:   obs.raw,
      treatmentObsWasWeeks:    obs.wasWeeks,
      treatmentObsClamped:     obs.wasClamped,
      startupCushionMonths:    startup.months,
      startupCushionMonthsRaw: startup.raw,
      durationFromCompletion,
      durationMonths,
      cumSuccessProb,
      // Bayesian RR diagnostics
      rrPriorGrid:       downsampleGrid(rrResult.priorGrid),
      rrPosteriorGrid:   downsampleGrid(rrResult.posteriorGrid),
      bandsBefore:       rrResult.bandsBefore,
      bandsAfter:        rrResult.bandsAfter,
      nullResponseRate:  rrResult.effectiveNullRR,
      isProxied:         stageInput.isTimeToEvent === true,
      comparatorUnreliable: rrResult.comparatorUnreliable,
      comparatorGrid:    rrResult.comparatorGrid,
      comparatorSigma2Effective: rrResult.comparatorSigma2,
      counterfactuals:   rrResult.counterfactuals,
    });

    // Advance drug truth for next stage: assume this stage succeeds
    currentMixture  = mixtureIfSuccess;
    cumPriorSuccess = cumSuccessProb;
    prevStage       = stageInput;
  }

  // ── Regulatory stage ──────────────────────────────────────────────────────
  // Fix B: reg-approval prob uses the orphan-GATED context (unearned orphan → no uplift).
  // Review months (timeline) stay on the ORIGINAL context so the P-impact stays isolated.
  const engineRegContext = gateOrphanForEngine(inputs.regulatoryContext, orphanConfirmed);
  // Build 3 (SCENARIO-ONLY): if a registration endpoint is supplied, derive reg confidence
  // from evidence (designation base rate × endpoint acceptability) via the ONE canonical
  // deriveRegConfidence, using the orphan-GATED context so Fix B still holds. Absent
  // (base path) → the flat REG_APPROVAL_PROB lookup, so FROZEN tripwires are byte-identical.
  const pApprovalGivenSuccess = inputs.regEndpoint
    ? deriveRegConfidence({
        designation: engineRegContext,
        endpointType: inputs.regEndpoint.endpointType,
        endpointEvidenceBasis: inputs.regEndpoint.endpointEvidenceBasis,
        regAcceptance: inputs.regEndpoint, // full observables → resolveRegAcceptanceLevel
      })
    : (REG_APPROVAL_PROB[engineRegContext] ?? 0.85);
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
    impliedLaunchYear: impliedLaunchYear(totalDurationMonths),
    modalityClassStatus: inputs.modalityClassStatus,
    classGraveyardProbability: inputs.classGraveyardProbability
      ?? (inputs.modalityClassStatus === "graveyard" ? 1 : 0),
    orphanGatedOff,
    revenuePVM,
    eNPVM,
    eROI,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Added to each mixture component's variance when a stage gating on a rate
// surrogate is followed by one gating on a hard time-to-event endpoint (Part 4).
// Moderate: reflects a real, not-fully-validated surrogate→hard translation
// without cratering the harder stage.
const SURROGATE_TRANSLATION_SIGMA2 = 0.15;

// Per-trial-success-stage multiplier applied when the modality/target class is a
// "graveyard" (zero approvals + documented failure pattern). ~20% relative
// increase in per-gate failure risk from the class base rate — the class-level
// tolerability/translation/execution risk NOT captured by the effect-size prior.
// Gentle because the effect prior already carries the class effect on effect SIZE;
// this compounds across gates (0.80 × 0.80 on a 2-gate path).
const MODALITY_META_RISK_HAIRCUT = 0.80;

// Base-rate ceilings on P(trial success). Detection ≠ success: a tight comparator
// or large n makes a difference easy to DETECT but does not make clinical success
// near-certain. No single trial's outcome is ~certain, so cap any stage; and cap a
// confirmatory (Phase 3 / pivotal) stage lower for the documented late-phase base-
// rate failure hazard. Sourced from clinical phase-transition data (BIO/Informa /
// Wong et al.): Phase-3→approval ~55-65% overall (lower in CNS); even a strong
// positive Phase 2 rarely implies a single pivotal above ~80%. General, all assets.
const STAGE_SUCCESS_CEILING = 0.90;       // any single stage
const LATE_PHASE_SUCCESS_CEILING = 0.80;  // confirmatory / Phase 3 stage

// ── Trial-conduct duration norms (months) ─────────────────────────────────────
// Sanity CEILINGS + a unit-normalizer for the launch-timeline model. They bound the
// per-component durations (enrollment, treatment/observation, startup) the LLM
// estimates per stage — the last unconstrained numeric inputs feeding launch year →
// revenue PV. Sourced from general clinical-operations benchmarks (Tufts CSDD trial-
// conduct data; typical oncology/CNS Phase 2–3 accrual and follow-up windows). They
// only clamp a NON-credible estimate; a credible one passes through unchanged. They
// touch NO probability — durations feed the timeline only.
const WEEKS_PER_MONTH = 4.345;
// A single trial-phase duration expressed in "months" but exceeding ~4.3 years is
// almost always a WEEK count dropped into a month field — CT.gov routinely states
// protocol windows in weeks ("76-week treatment", "96-week extension"). >52 "months"
// (>4.3y) for one component is implausible while 52–104 weeks (1–2y) is routine, so
// above this threshold we read the value as weeks and convert.
const WEEKS_AS_MONTHS_THRESHOLD = 52;
const MAX_TREATMENT_OBS_MONTHS = 36;   // even long adjuvant / disease-modifying readouts ≤ ~3y
const MAX_STARTUP_MONTHS = 12;         // site activation / IRB-EC / first-patient-in

// Enrollment-accrual ceiling by phase (patients accrue over this window). A large
// Phase 3 legitimately accrues longer than a Phase 2; beyond these implies a non-
// credible accrual rate, not a real timeline.
function maxEnrollmentMonths(phase: string): number {
  if (/3|registration|pivotal/i.test(phase)) return 48;
  if (/phase 1\b|preclinical/i.test(phase)) return 24;
  return 36; // Phase 2 (and default)
}

// Normalize an LLM month-field to credible months: convert an obvious week-count,
// then clamp to a ceiling. Returns flags so the UI can show what was corrected.
function normalizeDurationMonths(raw: number, ceiling: number): {
  months: number; wasWeeks: boolean; wasClamped: boolean; raw: number;
} {
  let v = Math.max(0, raw || 0);
  let wasWeeks = false;
  if (v > WEEKS_AS_MONTHS_THRESHOLD) { v = v / WEEKS_PER_MONTH; wasWeeks = true; }
  let wasClamped = false;
  if (v > ceiling) { v = ceiling; wasClamped = true; }
  return { months: v, wasWeeks, wasClamped, raw };
}

function addMixtureVariance(mixture: EffectPriorMixture, add: number): EffectPriorMixture {
  return mixture.map((c) => ({ ...c, sigma2: c.sigma2 + add }));
}

// Fix B: downgrade an orphan designation to its non-orphan equivalent for ENGINE
// purposes (significance bar + reg-approval prob) when the orphan status is NOT
// confirmed for the base-case indication. orphan→standard, btd_orphan→btd. All
// other contexts pass through. Timeline/review-months are NOT gated here (left on the
// original context) so this fix's P-impact stays isolated from the timeline.
function gateOrphanForEngine(ctx: RegulatoryContext, confirmed: boolean): RegulatoryContext {
  if (confirmed) return ctx;
  if (ctx === "orphan") return "standard";
  if (ctx === "btd_orphan") return "btd";
  return ctx;
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function round1(x: number)  { return Math.round(x * 10) / 10; }
function round2(x: number)  { return Math.round(x * 100) / 100; }
