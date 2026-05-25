// ─── PTRS Mechanism Scorer — Layer 1: Drug Effect Truth Curve ─────────────────
//
// Scores the pharmacological signal strength of a drug based on:
//   Sub-component 1: Intrinsic Potency Score (IPS) — factors 1A–1E
//   Sub-component 2: Translational Reliability Score (TRS) — factors 2A–2D
//
// MSS (Mechanism Signal Strength) = 0.5 × IPS + 0.5 × TRS (simple average)
//   Rationale: multiplication/geometric mean penalizes moderate scores too harshly.
//   Simple average preserves intuition: two decent scores → decent MSS.
//   Divergence (|IPS - TRS| > 0.25) still increases σ² as a separate signal.
//
// PTRS Adjustment: asymmetric piecewise linear on MSS
//   Upside  (MSS ≥ 0.50): adjustment = (MSS - 0.50) × 0.55, cap +0.20
//   Downside (MSS < 0.50): adjustment = (MSS - 0.50) × 0.30, floor -0.15
//   Rationale: phase baselines already bake in average failure rates.
//   A good mechanism is the primary upside signal; a bad mechanism adds uncertainty
//   but the phase baseline has already discounted most failures.
//
// CI: PTRS ± ciHalfWidth where ciHalfWidth = σ² × 0.32 + 0.02

// ─── Weights ──────────────────────────────────────────────────────────────────

export const IPS_WEIGHTS = {
  potency: 0.25,            // 1A — how strongly does the drug hit its target
  selectivity: 0.20,        // 1B — does it hit the right target vs off-targets
  pkProfile: 0.20,          // 1C — does it stay at the target long enough
  targetEngagement: 0.20,   // 1D — confirmed clinical target engagement evidence
  therapeuticWindow: 0.15,  // 1E — ratio of efficacy dose to toxic dose
};

export const TRS_WEIGHTS = {
  targetValidation: 0.35,    // 2A — how well validated is this target
  indicationMechFit: 0.30,   // 2B — is the target central to this disease
  modalityFit: 0.20,         // 2C — is this drug modality suited to the target
  translationRate: 0.15,     // 2D — historical preclinical→clinical rate for this class
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
  potency: FactorScore;           // 1A
  selectivity: FactorScore;       // 1B
  pkProfile: FactorScore;         // 1C
  targetEngagement: FactorScore;  // 1D
  therapeuticWindow: FactorScore; // 1E

  // Sub-component 2: Translational Reliability
  targetValidation: FactorScore;    // 2A
  indicationMechFit: FactorScore;   // 2B
  modalityFit: FactorScore;         // 2C
  translationRate: FactorScore;     // 2D
};

export type MechanismScoreResult = {
  ips: number;            // Intrinsic Potency Score (0–1)
  trs: number;            // Translational Reliability Score (0–1)
  mss: number;            // Mechanism Signal Strength = 0.5×IPS + 0.5×TRS (0–1)
  divergence: boolean;    // true when |IPS - TRS| > 0.25 (extra uncertainty)
  variance: number;       // σ² — uncertainty in the score (0–1)
  ciHalfWidth: number;    // half-width of the 80% PTRS confidence interval (in probability units)
  ptrsAdjustment: number; // additive adjustment to phase baseline PTRS
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
  // Sub-component 1: Intrinsic Potency Score (5 factors)
  const ips =
    factors.potency.score * IPS_WEIGHTS.potency +
    factors.selectivity.score * IPS_WEIGHTS.selectivity +
    factors.pkProfile.score * IPS_WEIGHTS.pkProfile +
    factors.targetEngagement.score * IPS_WEIGHTS.targetEngagement +
    factors.therapeuticWindow.score * IPS_WEIGHTS.therapeuticWindow;

  // Sub-component 2: Translational Reliability Score (4 factors)
  const trs =
    factors.targetValidation.score * TRS_WEIGHTS.targetValidation +
    factors.indicationMechFit.score * TRS_WEIGHTS.indicationMechFit +
    factors.modalityFit.score * TRS_WEIGHTS.modalityFit +
    factors.translationRate.score * TRS_WEIGHTS.translationRate;

  // Mechanism Signal Strength — simple average of IPS and TRS
  // Simple average preserves intuition: two 60-point components → 60 MSS.
  // Geometric mean and multiplication were penalizing moderate-but-real signals.
  const mss = clamp01(0.5 * ips + 0.5 * trs);

  // Divergence flag: IPS and TRS disagree by more than 25 points
  // (pharmacologically strong but biologically weak, or vice versa)
  const divergence = Math.abs(ips - trs) > 0.25;

  // Variance — increases with unknown factors, high-variance flags, and divergence
  const allFactors = Object.values(factors);
  const unknownCount = allFactors.filter(f => f.confidence === "unknown").length;
  const highVarianceCount = allFactors.filter(f => f.highVariance).length;
  const variance = clamp01(
    0.05 +
    (unknownCount / allFactors.length) * 0.35 +
    (highVarianceCount / allFactors.length) * 0.25 +
    (divergence ? 0.10 : 0)
  );

  // Confidence interval half-width (in probability units, e.g. 0.10 = ±10%)
  // Calibrated so σ²=0.24 → ±10%, σ²=0.50 → ±18%, σ²=0.05 → ±4%
  const ciHalfWidth = clamp01(variance * 0.32 + 0.02);

  // PTRS adjustment — asymmetric piecewise linear centered at MSS=0.50
  //
  // Upside  (MSS ≥ 0.50): stronger signal, steeper slope
  //   MSS 0.60 → +5.5%   MSS 0.65 → +8.3%   MSS 0.80 → +16.5%
  //
  // Downside (MSS < 0.50): shallower slope (phase baseline already prices in average failure)
  //   MSS 0.35 → -4.5%   MSS 0.20 → -9.0%   MSS 0.10 → -12%
  const ptrsAdjustment = mss >= 0.5
    ? clamp((mss - 0.5) * 0.55, 0, 0.20)
    : clamp((mss - 0.5) * 0.30, -0.15, 0);

  // Human-readable summary
  const mssLabel = mss >= 0.8 ? "strong" : mss >= 0.6 ? "moderate-strong" : mss >= 0.4 ? "moderate" : mss >= 0.2 ? "weak-moderate" : "weak";
  const summary =
    `Mechanism signal strength: ${mssLabel} (MSS ${mss.toFixed(2)}). ` +
    `Potency profile (IPS ${ips.toFixed(2)}): ` +
    `potency ${factors.potency.score.toFixed(2)}, selectivity ${factors.selectivity.score.toFixed(2)}, ` +
    `PK ${factors.pkProfile.score.toFixed(2)}, engagement ${factors.targetEngagement.score.toFixed(2)}, ` +
    `therapeutic window ${factors.therapeuticWindow.score.toFixed(2)}. ` +
    `Translational reliability (TRS ${trs.toFixed(2)}): ` +
    `target validation ${factors.targetValidation.score.toFixed(2)}, indication fit ${factors.indicationMechFit.score.toFixed(2)}, ` +
    `modality fit ${factors.modalityFit.score.toFixed(2)}, translation rate ${factors.translationRate.score.toFixed(2)}. ` +
    `Uncertainty (σ² ${variance.toFixed(2)}${divergence ? ", IPS/TRS divergence flagged" : ""}).`;

  return { ips, trs, mss, divergence, variance, ciHalfWidth, ptrsAdjustment, factors, summary };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clamp(x: number, min: number, max: number) { return Math.max(min, Math.min(max, x)); }
