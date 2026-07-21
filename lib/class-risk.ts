// ─── Class-graveyard risk as a deterministic probability (tau reproducibility, Part 2) ─
//
// "Is this modality/target class a graveyard?" is a genuine JUDGMENT (tau: all
// N-terminal anti-tau antibodies failed, but MTBR is a differentiated sub-mechanism
// with its own POC). Both "graveyard" and "mixed" are defensible readings of the
// SAME evidence — which is why a fresh qualitative LLM call FLIPS between them run-
// to-run (tau: graveyard↔mixed → haircut ×0.80↔×1.0). The fix is NOT to force one
// label: it is to make the classification a DETERMINISTIC FUNCTION of the analog
// step's STRUCTURED, factual findings (failure counts, approvals, differentiation),
// which are stable run-to-run, and to output a PROBABILITY the haircut blends over
// — so the same evidence always yields the same haircut.
//
// The probabilistic output is deliberately the first brick of the future scenario-
// modeling feature (judgment calls as weighted branches). NO UI is built here.
//
// PURE, no I/O. Touches the haircut INPUT, not the stage-success formula.

import type { ClassStatus, ClassEvidence } from "./effect-prior";

// ClassEvidence (the structured, FACTUAL analog-class findings this rule consumes)
// is defined in effect-prior.ts, the types hub, and re-exported here for callers.
export type { ClassEvidence };

export type ClassRisk = {
  pGraveyard: number;      // deterministic P(class is a true graveyard for this asset) ∈ [0,1]
  classStatus: ClassStatus;
  provenance: string;
};

// ~this many documented failures ≈ a strong class-graveyard signal (saturating).
const GRAVEYARD_FAILURE_ANCHOR = 4;
// A differentiated sub-mechanism with its own POC removes ~40% of the class base-
// rate risk — meaningful, but does NOT erase a heavily-failed class's history.
const DIFFERENTIATION_RETENTION = 0.6;
// pGraveyard at/above this reads as a "graveyard" label (below → "mixed").
const GRAVEYARD_LABEL_THRESHOLD = 0.6;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Deterministic class-risk probability from structured analog findings. Same
 * evidence → same p_graveyard EVERY run. Rules (fixed):
 *  - ≥1 approved/precedented class member → "precedent"; only residual class risk.
 *  - no approvals and no documented failures → "none" (nothing to price).
 *  - otherwise p rises (saturating) with the failure count, discounted when a
 *    differentiated sub-mechanism with its own POC is present; the label is a
 *    deterministic band of p.
 * The haircut consumer blends: haircut = 1 − (1 − 0.80)·p_graveyard.
 */
export function classGraveyardProbability(ev: ClassEvidence): ClassRisk {
  const failures = Math.max(0, Math.trunc(ev.sameTargetFailures || 0));
  const approvals = Math.max(0, Math.trunc(ev.approvedInClass || 0));
  const differentiated = ev.differentiatedSubMechanismWithPOC === true;

  if (approvals >= 1) {
    const pG = round2(clamp01(0.10 + 0.03 * failures - 0.05 * approvals));
    return {
      pGraveyard: pG,
      classStatus: "precedent",
      provenance: `precedent: ${approvals} approved/precedented class member(s)${failures ? ` despite ${failures} failure(s)` : ""} → residual class risk p(graveyard)=${pG}`,
    };
  }

  if (failures === 0) {
    return {
      pGraveyard: 0,
      classStatus: "none",
      provenance: "none: no approved members and no documented class failures (nothing to price as class risk)",
    };
  }

  const failSignal = clamp01(0.9 * (1 - Math.exp(-failures / GRAVEYARD_FAILURE_ANCHOR)));
  const pG = round2(clamp01(differentiated ? failSignal * DIFFERENTIATION_RETENTION : failSignal));
  const classStatus: ClassStatus = pG >= GRAVEYARD_LABEL_THRESHOLD ? "graveyard" : "mixed";
  return {
    pGraveyard: pG,
    classStatus,
    provenance:
      `${classStatus}: ${failures} documented class failure(s), 0 approved` +
      (differentiated ? ", differentiated sub-mechanism w/ POC (class risk discounted)" : "") +
      ` → p(graveyard)=${pG}`,
  };
}

/**
 * Deterministic analog-step effect-size signal (μ/σ²) from the SAME structured class
 * facts (Part A). The analog step's μ/σ² was the last un-pinned lever: its structured
 * facts are stable run-to-run, but the LLM re-derived a fresh μ/σ² point estimate each
 * run (tau: μ swung 0.28↔0.38), swinging finalMss → P(approval). This resolves μ/σ²
 * as a FIXED FUNCTION of the facts — NO LLM in the resolution path — so the same facts
 * always give the same signal.
 *
 * CALIBRATED to reproduce what the analog step already produced on average (this is a
 * REPRODUCIBILITY fix, NOT a recalibration of the prior):
 *   • class graveyard (0 approvals, ≥1 failure, not differentiated) → μ 0.30 — matches
 *     BOTH captured anchors: TTX-MC138 (3-failure miRNA-oncology graveyard, μ 0.30/σ²
 *     0.18) and tau (4–5-failure anti-tau-mAb graveyard, μ 0.28–0.38 center ~0.31).
 *   • σ² tightens as consistent failures accumulate (≥4 → 0.13, else 0.18), matching
 *     SCALE_CALIBRATION "3+ consistent failures → low σ² (high confidence in the negative)".
 *   • a differentiated sub-mechanism WITH human POC offsets μ up (0.50).
 *   • ≥1 approval → precedent: μ near neutral. No failures/approvals → uninformative-wide.
 * The graveyard μ (0.30) sits at the center of the observed 0.28–0.38 range — variance
 * removed, central estimate unchanged.
 */
export function analogEffectSignal(ev: ClassEvidence): { mu: number; sigma2: number } {
  const failures = Math.max(0, Math.trunc(ev.sameTargetFailures || 0));
  const approvals = Math.max(0, Math.trunc(ev.approvedInClass || 0));
  const differentiated = ev.differentiatedSubMechanismWithPOC === true;

  if (approvals >= 1) {
    const mu = Math.max(0.6, Math.min(1.15, 0.90 + 0.05 * approvals - 0.05 * failures));
    return { mu: round2(mu), sigma2: 0.22 };
  }
  if (failures === 0) return { mu: 1.0, sigma2: 0.45 }; // no class track record → uninformative
  return {
    mu: differentiated ? 0.50 : 0.30,
    sigma2: failures >= 4 ? 0.13 : 0.18,
  };
}

/**
 * The deterministic haircut the dev plan applies, as a BLEND over p_graveyard:
 * a graveyard-certain class (p=1) gets the full ×0.80; a validated class (p=0)
 * gets ×1.0; a genuinely-split class gets the weighted value in between. Exposed
 * so the live path, the harness, and the UI all compute the identical number.
 */
export function graveyardHaircut(pGraveyard: number, fullHaircut: number): number {
  return 1 - (1 - fullHaircut) * clamp01(pGraveyard);
}
