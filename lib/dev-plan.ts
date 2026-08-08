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
import { mixtureMoments, enrichEffectPrior, resolveEnrichmentLift, type EffectPriorMixture, type ClassStatus } from "./effect-prior";
import { pinCostPerPatient, type TherapeuticArea } from "./financial-pins";
import { graveyardHaircut } from "./class-risk";
import { sigma2FromBounds, rangeIncoherence, crossCheckDisagreement } from "./elicitation";
import {
  computeStageRR,
  gridToGaussianMixture,
  downsampleGrid,
  MEANINGFUL_RR_FLOOR,
  TTE_PROXY_RR_FLOOR,
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

// The graded regulatory-acceptance scale. Deltas apply on top of the designation base rate;
// L1 > L2 > L3 > L4 by construction. L4 requires POSITIVE evidence of no precedent (flagged).
// "held_unconfirmed" is the base-re-pin default: when acceptability is UNCONFIRMABLE (no
// observables emitted), do NOT auto-penalize to L4 — HOLD at the base rate (delta 0) and FLAG.
// Absence of evidence is a flag, not a verdict.
export type RegAcceptanceLevel =
  | "L1_precedented_outcome"    // hard clinical outcome (OS, CR, organ function) — agency-preferred
  | "L2_validated_surrogate"    // FDA guidance accepts it OR ≥1 full in-class approval on it
  | "L3_thin_precedent"         // only accelerated-approval precedent on it (confirmation pending)
  | "L4_no_precedent"           // POSITIVE evidence of no precedent (approvals resolved = "none") → FLAGGED
  | "held_unconfirmed";         // unconfirmable (no observables) → hold at base rate (delta 0), FLAGGED
const REG_ACCEPTANCE_DELTA: Record<RegAcceptanceLevel, number> = {
  L1_precedented_outcome:  REG_ENDPOINT_HARD_BONUS,
  L2_validated_surrogate:  0,
  L3_thin_precedent:      -REG_ACCEPTANCE_THIN_PENALTY,
  L4_no_precedent:        -REG_ENDPOINT_SURROGATE_INFERRED_PENALTY,
  held_unconfirmed:        0,   // base rate held; the flag (not a penalty) signals "unconfirmed"
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

// RESOLVE observables → level (+ flagged). L4 requires POSITIVE evidence of no precedent;
// an unconfirmable endpoint (no observables) HOLDS at the base rate and is FLAGGED — never
// auto-penalized to L4. Absence of evidence is a flag, not a verdict.
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

  // An explicit CONFIRMED (FDA-accepted) basis maps to a validated surrogate.
  if (obs.endpointEvidenceBasis === "CONFIRMED") return { level: "L2_validated_surrogate", flagged: false };

  // L4 only from POSITIVE evidence of no precedent (approvals explicitly resolved to "none").
  if (obs.priorFullApprovalsOnEndpoint === "none") return { level: "L4_no_precedent", flagged: true };

  // Unconfirmable (INFERRED / unset, no observables) → HOLD at base rate, FLAGGED.
  // Absence of evidence is a flag, not an L4 verdict.
  return { level: "held_unconfirmed", flagged: true };
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
  // SOURCED expected response rate for THIS stage's endpoint — the drug's own observed data on that
  // endpoint or a NAMED analog. Sets the stage's margin scale (Δ_stage, the dScale/hrScale pattern) so
  // a rate-evidenced asset carries its real margin instead of the 0.10 default. Resolve-or-flag: used
  // ONLY when expectedResponseRateBasis names a source — an uncited number is ignored + flagged.
  expectedResponseRate?: number;
  expectedResponseRateBasis?: string;
  // The BASELINE null the effect prior's margin is scored against, when it differs from
  // nullResponseRate — i.e. when an option RAISED this stage's bar (active comparator / corrected
  // control rate). The prior anchors here; the raised nullResponseRate is only the threshold, so a
  // harder bar genuinely lowers P instead of re-anchoring the prior up with it. Absent → the stage's
  // own nullResponseRate is both anchor and threshold (the unmodified base case).
  anchorNullResponseRate?: number;
  observedResponseRate?: number;  // actual observed RR from a completed trial
  observedN?: number;             // n for the observed result
  isTimeToEvent?: boolean;        // true = OS/PFS/DFS endpoint, approximated via RR proxy
  comparatorSigma2?: number;      // variance of the historical control estimate
                                  //   0 for RCTs (control measured in-trial)
                                  //   >0 for single-arm vs uncertain historical benchmark
  comparatorSource?: string;      // where the comparator rate comes from (for display)
  // ELICITATION (module 1): the comparator's plausible range, stated as 15/85 bounds — the natural
  // unit an SME can actually give. When valid, deterministic code derives σ² from it (elicitation.ts)
  // and it SUPERSEDES a raw comparatorSigma2 emission (an LLM cannot calibrate a raw variance; it can
  // state a range). Absent → legacy raw σ² path, bit-for-bit.
  comparatorRateLow?: number;
  comparatorRateHigh?: number;
  // Checker findings for this stage (validated display prose from the elicitation checker — the API
  // attaches them; they ride the existing riskFlags rail; never numeric, never computed with).
  elicitationFindings?: TrialRiskFlag[];

  // Endpoint transparency
  endpointRationale?: string;            // plain-language: why this endpoint for this stage
  endpointEvidenceBasis?: "CONFIRMED" | "INFERRED"; // confirmed by company vs FDA precedent/inference
  // Base re-pin (G3): registration-endpoint reg-acceptance observables. On the registration
  // (last) stage these let the UNIFIED base reg gate resolve L1–L4 (resolveRegAcceptanceLevel),
  // exactly like the scenario axis. Absent → hold-at-base-rate + flag (never auto-L4).
  fdaGuidanceForEndpoint?: boolean;
  priorFullApprovalsOnEndpoint?: "none" | "one_or_two" | "many";
  acceleratedOnlyPrecedent?: boolean;
  approvedInClassOnEndpoint?: boolean;
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

  // Margin scale — ALWAYS surfaced (§1.5): the single number that sets how big a claim the prior
  // makes. 0.10 = the validated clinical-meaningfulness default; anything else means a SOURCED
  // expected response rate re-derived it (Δ_stage = (sourcedRR − anchor)/μ̄) and the prior mean now
  // sits ON that sourced rate — the reader must be able to see which rate and whose citation did it.
  deltaStageRR: number;
  deltaStageSourced: boolean;
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

  // ── Layer 2 design-aware power outputs (present only when a design spec targeted THIS stage) ──
  designFlags?: string[]; // resolve-or-flag notes from computeStageRR (PP-deferred, CP-deferred, …)
  sequentialDesign?: {
    zBoundaries: number[];
    expectedInfoFraction: number; // E[N]/max at the prior-mean effect — a SURFACED output, NOT wired to cost
    expectedN: number;
    futilityZBoundaries?: number[];
    futilityBinding?: boolean;
    achievedTypeI?: number; // binding: the verified H0 type-I after the fixed-point (≈ α)
  };
  bayesianDesign?: { kStar: number; emergentAlpha: number; analysisPriorSourced: boolean };
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
  // Echoed inputs for per-option plan parity (decision-analysis rebuilds plans from these; see the
  // return-site comment) + the replication weight actually applied (post-clamp; null = none).
  therapeuticArea?: TherapeuticArea;
  orphanConfirmedForIndication?: boolean;
  replicationRisk?: { pFail: number; basis: string };
  replicationWeightApplied?: number | null;
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
  // INDICATION-LEVEL replication risk (LLM-emitted OBSERVABLE, citation-gated — the "IPF trap").
  // pFail = P(this indication's positive early-phase efficacy signal fails to reproduce in later
  // trials), grounded ONLY in the indication's NAMED Phase-2→confirmatory replication record (e.g.
  // IPF: nintedanib replicated; pamrevlumab, zinpentraxin, ziritaxestat, IFN-γ failed Phase 3 after
  // positive earlier signals). Applied as a discrete failure-mass mixture component {w, μ=0} on the
  // INITIAL prior — the same structural move as the surrogate→TTE translation component, because a
  // "the signal isn't real/durable" hypothesis is a discrete failure mode that symmetric variance
  // (σ²·Δ²) structurally cannot represent: with a large sourced margin the Gaussian prior can sit
  // 4σ above threshold and saturate every stage power, no matter how honest σ is.
  // NO-DOUBLE-COUNT: the effect prior's analog step carries MECHANISM-class effect-size evidence;
  // the modality haircut carries mechanism-class gate-completion risk; this component carries the
  // INDICATION's signal-durability record, mechanism-agnostic. The prompt forbids counting either
  // of the other two here. Bayes shrinks the component after each observed stage success (it sits
  // in the mixture during propagation), so it self-retires as real evidence accumulates.
  // Citation-gated (§1.5): no basis → ignored + flagged. Band-clamped with the clamp shown.
  replicationRisk?: {
    pFail: number; basis: string;
    // Elicitation additions: extremes-first bounds (15/85) + the consistency cross-check in a second
    // framing ("of 10 comparable positive Phase 2 signals in this indication, how many fail to
    // reproduce?"). Display + coherence checks only in v1 — the engine still consumes pFail.
    pFailLow?: number; pFailHigh?: number; crossCheckOutOf10?: number;
  };
};

// Replication-risk weight band. 0.80 lets the worst documented indication records (~4 failures per
// success) be expressed; a record worse than that belongs in the effect prior's class evidence (the
// anti-tau pattern), not in a dev-plan weight. Below 0.05 the emission is noise → IGNORED (never
// raised to the floor — the engine must not add risk the source didn't claim). Above 0.80 → clamped
// DOWN with the clamp shown (§1.5).
const REPLICATION_PFAIL_MIN = 0.05;
const REPLICATION_PFAIL_MAX = 0.80;

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

  // ── Indication replication-risk component (see DevPlanInputs.replicationRisk) ──────────────────
  // Applied ONCE to the initial prior; propagation then owns it (a survived stage success Bayes-shrinks
  // the failure weight automatically, so it self-retires as the drug earns real replications).
  // Capability-gated: absent → the mixture is untouched → bit-for-bit legacy (FROZEN-safe).
  let replicationWeightApplied: number | null = null;
  let replicationFlag: TrialRiskFlag | null = null;
  const replicationExtraFlags: TrialRiskFlag[] = [];
  {
    const rr = inputs.replicationRisk;
    if (rr != null && typeof rr.pFail === "number" && Number.isFinite(rr.pFail) && rr.pFail > 0) {
      const basis = rr.basis?.trim() ?? "";
      if (!basis) {
        replicationFlag = {
          severity: "info",
          message: `replicationRisk ${(rr.pFail * 100).toFixed(0)}% UNCITED (no named Phase 2→confirmatory record for this indication) → ignored`,
        };
      } else if (rr.pFail < REPLICATION_PFAIL_MIN) {
        replicationFlag = {
          severity: "info",
          message: `replicationRisk ${(rr.pFail * 100).toFixed(1)}% is below the ${REPLICATION_PFAIL_MIN * 100}% noise floor → ignored (the engine never raises a cited risk above what the source claimed)`,
        };
      } else {
        const w = Math.min(rr.pFail, REPLICATION_PFAIL_MAX);
        currentMixture = [
          ...currentMixture.map((c) => ({ ...c, w: c.w * (1 - w) })),
          { w, mu: 0, sigma2: 0.05 },
        ];
        replicationWeightApplied = w;
        // Elicitation additions (module 1): show the extremes-first range; check its coherence; and
        // compare the probability framing against the "N of 10" frequency framing — two framings of
        // one belief that SHOULD agree, and whose disagreement is signal (§1.5: surfaced, not hidden).
        const rangeIncoherent = (rr.pFailLow != null || rr.pFailHigh != null)
          ? rangeIncoherence(rr.pFailLow, rr.pFail, rr.pFailHigh, "replicationRisk")
          : null;
        if (rangeIncoherent) replicationExtraFlags.push({ severity: "info", message: rangeIncoherent });
        const rangeTxt = !rangeIncoherent && rr.pFailLow != null && rr.pFailHigh != null
          ? ` [elicited 15/85 range ${(rr.pFailLow * 100).toFixed(0)}–${(rr.pFailHigh * 100).toFixed(0)}%]`
          : "";
        const xc = crossCheckDisagreement(rr.pFail, rr.crossCheckOutOf10);
        if (xc) replicationExtraFlags.push({ severity: "medium", message: `replication risk ${xc}` });
        replicationFlag = {
          severity: "medium",
          message: `indication replication risk: ${(w * 100).toFixed(0)}% prior weight that the positive early-phase signal does not reproduce in later trials${rangeTxt}` +
            (w !== rr.pFail ? ` (requested ${(rr.pFail * 100).toFixed(0)}%, CLAMPED to the ${REPLICATION_PFAIL_MAX * 100}% cap)` : "") +
            ` — ${basis}. This weight shrinks after each observed trial success (Bayes), and is distinct from the mechanism-class haircut.`,
        };
      }
    }
  }

  for (const stageInput of inputs.stages) {

    // ── Surrogate-translation penalty (Part 4, re-expressed for the 2.2 anchored scale) ─────────
    // If the previous stage gated on a RATE surrogate (e.g. ctDNA clearance) and THIS stage gates on
    // a harder time-to-event endpoint (e.g. RFS), the molecular-surrogate → clinical-endpoint link is
    // not fully validated in this setting. Previously modeled as VARIANCE WIDENING
    // (addMixtureVariance(σ²+0.15)) — which only attenuated P by accident of the old absolute scale.
    // On the anchored scale, symmetric widening around a mean in the CONVEX region of the power curve
    // can RAISE the integral (Jensen), inverting the penalty. Re-expressed as what the risk actually
    // is: a TRANSLATION-FAILURE component — with probability p_fail the surrogate effect simply does
    // not carry to the hard endpoint (μ → 0, no margin), else the belief is unchanged. This
    // attenuates monotonically by construction: P_new ≈ (1 − p_fail)·P_old + p_fail·(≈α). The 0.15 is
    // the SAME hand-set, pre-calibration magnitude the widening used, now with the honest semantics
    // (a 15% chance the surrogate win means nothing for the hard endpoint); the empirical replacement
    // is a calibration deliverable (observed surrogate→hard concordance rates by setting).
    if (prevStage && prevStage.isTimeToEvent === false && stageInput.isTimeToEvent === true) {
      const pFail = SURROGATE_TRANSLATION_FAILURE_P;
      currentMixture = [
        ...currentMixture.map((c) => ({ ...c, w: c.w * (1 - pFail) })),
        { w: pFail, mu: 0, sigma2: 0.05 }, // no-translation component: zero margin over the comparator
      ];
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

    // G2 Phase 2a: forward sourced CONTINUOUS stats (outcomeSd + expectedDelta) to the
    // engine only when BOTH are present → native two-sample power; else omitted → proportion
    // path (FROZEN byte-identical). computeStageRR fills in the dScale calibration.
    const td = stageInput.trialDesign;
    const continuous =
      typeof td.outcomeSd === "number" && td.outcomeSd > 0 &&
      typeof td.mdeOrExpectedDelta === "number" && td.mdeOrExpectedDelta > 0
        ? { outcomeSd: td.outcomeSd, expectedDelta: td.mdeOrExpectedDelta }
        : undefined;
    const rrDesign: RRTrialDesign = {
      designType:        stageInput.trialDesign.designType,
      endpointType:      stageInput.trialDesign.endpointType,
      populationType:    stageInput.trialDesign.populationType,
      ...(continuous ? { continuous } : {}),
      // Layer 2 spec-delivery bridge: OPTIONAL design-aware power families, GATED on presence. Absent
      // (every existing call + both tripwire fixtures) → these spreads add NOTHING → rrDesign is the
      // identical object → computeStageRR receives identical arguments → FROZEN byte-identical. The
      // effect stays in the prior (single-locus); computeStageRR resolves the markers. No default design,
      // no default look-schedule, no default alpha is injected here.
      ...(td.alpha ? { alpha: td.alpha } : {}),
      ...(td.tte ? { tte: td.tte } : {}),
      ...(td.sequential ? { sequential: td.sequential } : {}),
      ...(td.bayesian ? { bayesian: td.bayesian } : {}),
      // Fix B: gate the orphan significance-bar benefit on indication-confirmation.
      regulatoryContext: gateOrphanForEngine(stageInput.trialDesign.regulatoryContext, orphanConfirmed),
    };

    // ── Per-stage biomarker enrichment (base re-pin — unified engine) ─────────
    // If THIS stage is biomarker-selected, its belief is enriched (enrichEffectPrior μ-shift)
    // for this stage's power/success ONLY — the SAME mechanism the scenario axis uses. It is
    // NON-PROPAGATING: a later broad stage runs on the un-enriched belief, never inheriting the
    // subgroup concentration (a biomarker Ph2 must not de-risk a broad Ph3). Replaces the
    // retired POP_N_FACTOR. Lift resolved once, shared with the scenario axis; unconfirmable
    // prevalence → DEFAULT + flag (never silent).
    const stageEnriched =
      td.populationType === "biomarker_selected" ||
      td.enrichmentEffectLift != null ||
      (td.biomarkerPrevalence != null && td.biomarkerPrevalence < 1);
    // Base unconfirmed-prevalence policy: fallback "hold" → a biomarker stage with no sourced
    // prevalence (and no explicit lift) holds at the un-enriched belief (lift 0) + flags, rather
    // than earning the DEFAULT lift. Mirrors the reg axis (unconfirmed → hold at base rate).
    // Scenario-supplied explicit lifts/prevalence still win (explicit/prevalence branches),
    // so the sourced-prevalence path is unaffected.
    const enrichment = stageEnriched
      ? resolveEnrichmentLift({ prevalence: td.biomarkerPrevalence, explicitLift: td.enrichmentEffectLift, fallback: "hold" })
      : { lift: 0, flagged: false };
    const powerMixture = enrichment.lift > 0 ? enrichEffectPrior(currentMixture, enrichment.lift) : currentMixture;

    // Replication-risk component surfaces on the FIRST stage's card (it re-shaped the initial prior
    // that this stage consumes; later stages inherit it through propagation).
    if (stages.length === 0) {
      if (replicationExtraFlags.length) l2.riskFlags.unshift(...replicationExtraFlags);
      if (replicationFlag) l2.riskFlags.unshift(replicationFlag);
    }
    // Checker findings (validated display prose attached by the API) ride the same flags rail.
    if (stageInput.elicitationFindings?.length) {
      l2.riskFlags.push(...stageInput.elicitationFindings);
    }

    // ── Comparator σ²: elicited 15/85 range SUPERSEDES a raw variance emission ──────────────────
    // An SME (human or AI) can state "the placebo/control rate plausibly runs 10–20%"; nobody can
    // calibrate a raw σ²=0.004 by feel. When a valid range was elicited, σ² derives from it
    // deterministically (elicitation.ts, 15/85 convention); the raw emission becomes a footnote.
    //
    // CONCURRENT-CONTROL RULE (the 8/7 8:48pm live finding): benchmark variance applies ONLY to
    // designs judged against an EXTERNAL benchmark (single-arm vs historical control). An RCT
    // measures its control arm IN-TRIAL, and the drug prior is expressed as a MARGIN over the
    // anchor — uncertainty in the null's absolute location largely cancels for a concurrent test
    // of the difference. This has always been the engine's documented convention
    // ("comparatorSigma2: 0 for RCTs"); the LLM violated it in every live run (0.003–0.01), and
    // the elicited ranges made the violation dominant (live: σ²=0.0093 crushed Phase 3 to 22%
    // when the convention gives ~50%). §1.2: an input contradicting the engine's own stated
    // semantics — corrected at the seam, visibly, for RCTs regardless of emission path.
    const elicitedComparatorSig2 = sigma2FromBounds(stageInput.comparatorRateLow, stageInput.comparatorRateHigh);
    const requestedComparatorSig2 = elicitedComparatorSig2 ?? stageInput.comparatorSigma2 ?? 0;
    const isConcurrentControl = stageInput.trialDesign.designType === "rct";
    const comparatorSig2 = isConcurrentControl ? 0 : requestedComparatorSig2;
    if (elicitedComparatorSig2 != null && !isConcurrentControl) {
      l2.riskFlags.push({
        severity: "info",
        message: `comparator σ² ${elicitedComparatorSig2.toFixed(4)} DERIVED from the elicited 15/85 range [${((stageInput.comparatorRateLow as number) * 100).toFixed(0)}–${((stageInput.comparatorRateHigh as number) * 100).toFixed(0)}%] (σ = width/2.073)` +
          (stageInput.comparatorSigma2 != null ? ` — supersedes the raw emitted σ² ${stageInput.comparatorSigma2}` : ""),
      });
    }
    if (isConcurrentControl && requestedComparatorSig2 > 0) {
      l2.riskFlags.push({
        severity: "info",
        message: `comparator σ² ${requestedComparatorSig2.toFixed(4)}${elicitedComparatorSig2 != null ? ` (from the elicited range [${((stageInput.comparatorRateLow as number) * 100).toFixed(0)}–${((stageInput.comparatorRateHigh as number) * 100).toFixed(0)}%])` : ""} EXCLUDED from the power computation — a concurrent-control RCT measures its control arm in-trial, so historical-benchmark uncertainty does not degrade its power (documented engine convention; benchmark variance applies to single-arm designs). The range still informs where the null sits.`,
      });
    }

    // Sourced expected rate — citation-gated AND unit-gated (resolve-or-flag):
    //  • no basis → ignored + flagged (never silently trusted; same contract as niche WAC/share/count).
    //  • basis without patient-proportion language → ignored + flagged. A response rate is a fraction
    //    of PATIENTS meeting a responder criterion; the deadliest emission error is a continuous
    //    effect size wearing rate clothing ("67% slowing of FVC decline" is a % improvement, not a %
    //    of patients — reading it as a rate multiplies the prior's margin ~3× and saturates every
    //    downstream trial power). The gate requires the basis to SAY it is a proportion of patients
    //    (responder/response-rate language); the prompt states this contract, and rejection is
    //    conservative (falls back to the validated 0.10 default, visibly).
    const expectedRRBasisTrim = stageInput.expectedResponseRateBasis?.trim() ?? "";
    const expectedRRUnitOk =
      /\bof\s+(?:all\s+|the\s+|treated\s+|enrolled\s+|evaluable\s+)?(?:patients|subjects|participants)\b/i.test(expectedRRBasisTrim) ||
      /\bresponders?\b|\bresponse\s+rate\b|\bORR\b|\b(?:clearance|remission|clearance\s+of\s+ctDNA)\s+rate\b/i.test(expectedRRBasisTrim);
    const expectedRRCited = stageInput.expectedResponseRate != null &&
      !!expectedRRBasisTrim && expectedRRUnitOk;
    const sourcedExpectedRR = expectedRRCited ? stageInput.expectedResponseRate : undefined;
    if (stageInput.expectedResponseRate != null && !expectedRRBasisTrim) {
      l2.riskFlags.push({
        severity: "info",
        message: `expectedResponseRate ${stageInput.expectedResponseRate} UNSOURCED (no basis) → ignored; margin scale held at the 0.10 default`,
      });
    } else if (stageInput.expectedResponseRate != null && !expectedRRUnitOk) {
      l2.riskFlags.push({
        severity: "info",
        message: `expectedResponseRate ${stageInput.expectedResponseRate} REJECTED — its basis ("${expectedRRBasisTrim.slice(0, 140)}") does not state a proportion of PATIENTS (responder/response-rate language). A % improvement or % slowing of a continuous measure is an effect size, not a response rate → ignored; margin scale held at the 0.10 default`,
      });
    }

    const rrResult = computeStageRR(
      powerMixture,
      stageInput.n,
      nullRR,
      rrDesign,
      stageInput.isTimeToEvent === true,
      stageInput.observedResponseRate,
      stageInput.observedN,
      comparatorSig2,
      stageInput.anchorNullResponseRate,
      sourcedExpectedRR,
    );

    // Propagation belief: the UN-enriched posterior, so the enrichment does NOT carry into the
    // next stage. Only when this stage was enriched (else reuse rrResult — byte-identical).
    const propagationResult = enrichment.lift > 0
      ? computeStageRR(
          currentMixture, stageInput.n, nullRR, rrDesign,
          stageInput.isTimeToEvent === true, stageInput.observedResponseRate, stageInput.observedN,
          comparatorSig2,
          stageInput.anchorNullResponseRate,
          sourcedExpectedRR,
        )
      : rrResult;

    const trialSuccessProbRaw = rrResult.trialSuccessProb;

    // Margin-scale resolve-or-flag (§1.5): the sourced-rate substitution is the single most
    // P-moving input a stage can carry, so EVERY outcome is named — fired (with the exact rate,
    // its basis, and the unit caveat), or cited-but-rejected (with why). The uncited case was
    // already flagged above, before the compute.
    if (rrResult.deltaStageSourced && sourcedExpectedRR != null) {
      l2.riskFlags.push({
        severity: "info",
        message: `margin scale SOURCED: prior mean set to the cited ${(sourcedExpectedRR * 100).toFixed(0)}% expected response rate (Δ_stage ${rrResult.deltaStageRR.toFixed(2)} vs default 0.10) — basis: ${stageInput.expectedResponseRateBasis!.trim()}. VERIFY the source reports a % of PATIENTS meeting a responder definition — a % improvement/slowing of a continuous measure is NOT a response rate`,
      });
    } else if (sourcedExpectedRR != null && !rrResult.deltaStageSourced) {
      l2.riskFlags.push({
        severity: "info",
        message: `expectedResponseRate ${(sourcedExpectedRR * 100).toFixed(0)}% cited but REJECTED (must exceed the anchor by >1pt and sit below 95%, with a usable prior mean) → margin scale held at the 0.10 default`,
      });
    }

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

    // Convert the posterior grid back to a Gaussian mixture for the next stage.
    // Uses the UN-enriched propagation posterior (propagationResult) so a biomarker stage's
    // concentration does NOT carry forward; identical to rrResult when the stage wasn't enriched.
    // Inverted with the SAME anchor the stage's prior was built on (the 2.2 anchored map's inverse) —
    // μ is the portable relative-effect quantity, so the earned margin re-expresses over the next
    // stage's own comparator context. The anchor uses the stage's own family floor, mirroring
    // computeStageRR exactly (a TTE-proxy stage anchors at the proxy floor).
    const stageFloor = stageInput.isTimeToEvent === true ? TTE_PROXY_RR_FLOOR : MEANINGFUL_RR_FLOOR;
    const stageAnchor = Math.max(stageInput.anchorNullResponseRate ?? nullRR, stageFloor);
    const mixtureIfSuccess = gridToGaussianMixture(
      propagationResult.posteriorGrid,
      currentMixture.length,
      stageAnchor,
      // The SAME margin scale the stage's prior used (sourced Δ_stage or the default): μ round-trips
      // as "fraction of the stage-expected margin achieved", so a success confirming ~90% of a sourced
      // margin seeds the next stage at ~90% of ITS margin scale — proportional, not absolute.
      propagationResult.deltaStageRR,
    );
    const { mss: mssIfSuccess, variance: varianceIfSuccess } = mixtureMoments(mixtureIfSuccess);

    // ── Cost accounting (Fix #2: cost-per-patient pinned to phase × TA benchmark) ─
    // This touches only dollar cost, never any probability.
    //
    // Designation propagation (the CPP side of Fix B): the rare/orphan PRICING band keys on the
    // CONFIRMED designation, not the LLM-emitted stage label. Confirmed → PROMOTED even when the stage
    // was emitted "standard" (the live taladegib gap: FDA + EC orphan designations confirmed and
    // displayed in the same run, stages emitted DESIGNATION "Standard" → priced on the general band,
    // systematically under-costing a designated asset — rare-disease trials genuinely cost more per
    // patient). Unconfirmed → an orphan-labeled stage is DOWNGRADED for pricing too (default-deny,
    // symmetric with the P-side gate; previously the raw label passed through, so an UNEARNED orphan
    // label collected the premium band). populationType rare_small still promotes independently.
    const stageCtx = stageInput.trialDesign.regulatoryContext;
    const pricingCtx: RegulatoryContext = orphanConfirmed
      ? (stageCtx === "btd" || stageCtx === "btd_orphan" ? "btd_orphan" : "orphan")
      : gateOrphanForEngine(stageCtx, false);
    const cppPin = pinCostPerPatient(stageInput.phase, inputs.therapeuticArea, {
      populationType:    stageInput.trialDesign.populationType,
      regulatoryContext: pricingCtx,
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
      deltaStageRR:      rrResult.deltaStageRR,
      deltaStageSourced: rrResult.deltaStageSourced,
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
      // Layer 2: surface design-aware outputs ONLY when present (a design spec targeted this stage).
      // Absent → nothing added → the DevStage is byte-identical to today.
      ...(rrResult.designFlags ? { designFlags: rrResult.designFlags } : {}),
      ...(rrResult.sequentialDesign ? { sequentialDesign: rrResult.sequentialDesign } : {}),
      ...(rrResult.bayesianDesign ? { bayesianDesign: rrResult.bayesianDesign } : {}),
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
  // Base re-pin: ONE reg gate for both axes. deriveRegConfidence always governs — the flat
  // REG_APPROVAL_PROB base branch is retired. A scenario regEndpoint wins; otherwise build the
  // acceptance observables from the LAST (registration) stage (endpoint + G3 observables), so
  // the base resolves L1–L4 — or HOLDS at the base rate + flags when unconfirmable (never
  // auto-L4). REG_APPROVAL_PROB[designation] remains the base rate INSIDE deriveRegConfidence.
  const regStageInput = inputs.stages[inputs.stages.length - 1];
  const regAcceptance: RegAcceptanceObservables = inputs.regEndpoint ?? {
    endpointType: regStageInput.trialDesign.endpointType,
    endpointEvidenceBasis: regStageInput.endpointEvidenceBasis,
    ...(regStageInput.fdaGuidanceForEndpoint != null ? { fdaGuidanceForEndpoint: regStageInput.fdaGuidanceForEndpoint } : {}),
    ...(regStageInput.priorFullApprovalsOnEndpoint != null ? { priorFullApprovalsOnEndpoint: regStageInput.priorFullApprovalsOnEndpoint } : {}),
    ...(regStageInput.acceleratedOnlyPrecedent != null ? { acceleratedOnlyPrecedent: regStageInput.acceleratedOnlyPrecedent } : {}),
    ...(regStageInput.approvedInClassOnEndpoint != null ? { approvedInClassOnEndpoint: regStageInput.approvedInClassOnEndpoint } : {}),
  };
  const pApprovalGivenSuccess = deriveRegConfidence({
    designation: engineRegContext,
    endpointType: regAcceptance.endpointType,
    endpointEvidenceBasis: regAcceptance.endpointEvidenceBasis,
    regAcceptance,
  });
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
    // Echoes so downstream per-option plans (decision-analysis) rebuild with the SAME inputs —
    // without these the options silently recompute on a different basis than the headline
    // (live-verified 8/7: option stages priced on the general CPP band while the base plan priced
    // rare_orphan, because therapeuticArea/orphanConfirmed never reached the option plans).
    therapeuticArea: inputs.therapeuticArea,
    orphanConfirmedForIndication: inputs.orphanConfirmedForIndication,
    replicationRisk: inputs.replicationRisk,
    replicationWeightApplied,
    revenuePVM,
    eNPVM,
    eROI,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Probability that a rate-surrogate win does NOT translate to the following hard time-to-event
// endpoint (Part 4, re-expressed for the anchored scale — see the translation-failure block above).
// HEURISTIC, pre-calibration: same 0.15 magnitude the old variance-widening penalty used, now as an
// explicit failure probability. Replace with observed surrogate→hard concordance rates at calibration.
const SURROGATE_TRANSLATION_FAILURE_P = 0.15;

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

// (addMixtureVariance was removed with the 2.2 rescale: its only caller — the surrogate→TTE
// translation penalty — was re-expressed as an explicit translation-failure mixture component,
// because symmetric variance widening no longer guarantees attenuation on the anchored scale.)

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
