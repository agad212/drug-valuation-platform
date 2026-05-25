// ─── PTRS Mechanism Scorer — Layer 1: Drug Effect Truth Curve ─────────────────
//
// Scores the pharmacological signal strength of a drug based on:
//   Sub-component 1: Intrinsic Potency Score (IPS) — factors 1A, 1B, 1C
//   Sub-component 2: Translational Reliability Score (TRS) — factors 2A, 2B
//
// MSS (Mechanism Signal Strength) = IPS × TRS
// MSS is then mapped to a PTRS adjustment on top of the phase baseline.

// ─── Weights ──────────────────────────────────────────────────────────────────

const IPS_WEIGHTS = {
  potency: 0.35,        // 1A — how strongly does the drug hit its target
  selectivity: 0.30,    // 1B — does it hit the right target vs off-targets
  pkProfile: 0.35,      // 1C — does it stay at the target long enough
};

const TRS_WEIGHTS = {
  targetValidation: 0.50,       // 2A — how well validated is this target
  indicationMechFit: 0.50,      // 2B — is the target central to this disease
};

// ─── Factor score types ───────────────────────────────────────────────────────

export type FactorScore = {
  score: number;          // 0–1
  confidence: "high" | "medium" | "low" | "unknown";
  rationale: string;      // one sentence
  highVariance: boolean;  // does this factor add uncertainty
};

export type MechanismFactors = {
  // Sub-component 1: Intrinsic Potency
  potency: FactorScore;         // 1A
  selectivity: FactorScore;     // 1B
  pkProfile: FactorScore;       // 1C

  // Sub-component 2: Translational Reliability
  targetValidation: FactorScore;    // 2A
  indicationMechFit: FactorScore;   // 2B
};

export type MechanismScoreResult = {
  ips: number;            // Intrinsic Potency Score (0–1)
  trs: number;            // Translational Reliability Score (0–1)
  mss: number;            // Mechanism Signal Strength = IPS × TRS (0–1)
  variance: number;       // σ² — uncertainty in the score (0–1)
  ptrsAdjustment: number; // additive adjustment to phase baseline PTRS (-0.15 to +0.20)
  factors: MechanismFactors;
  summary: string;        // human-readable explanation
};

// ─── Default "unknown" factor — used when data is missing ────────────────────

export const UNKNOWN_FACTOR: FactorScore = {
  score: 0.4,
  confidence: "unknown",
  rationale: "Insufficient data — using conservative default.",
  highVariance: true,
};

// ─── Scoring engine ───────────────────────────────────────────────────────────

export function scoreMechanism(factors: MechanismFactors): MechanismScoreResult {
  // Sub-component 1: Intrinsic Potency Score
  const ips =
    factors.potency.score * IPS_WEIGHTS.potency +
    factors.selectivity.score * IPS_WEIGHTS.selectivity +
    factors.pkProfile.score * IPS_WEIGHTS.pkProfile;

  // Sub-component 2: Translational Reliability Score
  const trs =
    factors.targetValidation.score * TRS_WEIGHTS.targetValidation +
    factors.indicationMechFit.score * TRS_WEIGHTS.indicationMechFit;

  // Mechanism Signal Strength
  const mss = clamp01(ips * trs);

  // Variance — increases with unknown factors, high-variance flags, and conflicts
  const allFactors = Object.values(factors);
  const unknownCount = allFactors.filter(f => f.confidence === "unknown").length;
  const highVarianceCount = allFactors.filter(f => f.highVariance).length;
  // Conflict: high IPS but low TRS (good drug, unproven biology) = extra uncertainty
  const conflict = ips > 0.7 && trs < 0.4;
  const variance = clamp01(
    0.05 +
    (unknownCount / allFactors.length) * 0.35 +
    (highVarianceCount / allFactors.length) * 0.25 +
    (conflict ? 0.15 : 0)
  );

  // Map MSS to a PTRS adjustment on top of the phase baseline
  // MSS 0.8–1.0 → +0.20, MSS 0.6–0.8 → +0.10, MSS 0.4–0.6 → 0,
  // MSS 0.2–0.4 → -0.08, MSS 0–0.2 → -0.15
  const ptrsAdjustment = clamp(
    mss >= 0.8 ? 0.20
    : mss >= 0.6 ? 0.10
    : mss >= 0.4 ? 0.00
    : mss >= 0.2 ? -0.08
    : -0.15,
    -0.15, 0.20
  );

  // Human-readable summary
  const mssLabel = mss >= 0.8 ? "strong" : mss >= 0.6 ? "moderate-strong" : mss >= 0.4 ? "moderate" : mss >= 0.2 ? "weak-moderate" : "weak";
  const summary =
    `Mechanism signal strength: ${mssLabel} (MSS ${mss.toFixed(2)}). ` +
    `Potency profile (IPS ${ips.toFixed(2)}): ` +
    `potency ${factors.potency.score.toFixed(2)}, selectivity ${factors.selectivity.score.toFixed(2)}, PK ${factors.pkProfile.score.toFixed(2)}. ` +
    `Translational reliability (TRS ${trs.toFixed(2)}): ` +
    `target validation ${factors.targetValidation.score.toFixed(2)}, indication fit ${factors.indicationMechFit.score.toFixed(2)}. ` +
    `Uncertainty (σ² ${variance.toFixed(2)}).`;

  return { ips, trs, mss, variance, ptrsAdjustment, factors, summary };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clamp(x: number, min: number, max: number) { return Math.max(min, Math.min(max, x)); }
