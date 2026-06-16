// ─── PTRS Trial Design Simulator — Layer 2 ────────────────────────────────────
//
// Given the drug's effect-strength mixture from the True Effect Prior (one or
// two Gaussian "curves" — see lib/effect-prior.ts), computes how often a trial
// with these specific design parameters would successfully detect the effect
// and meet its primary endpoint.
//
// Math: closed-form normal CDF per mixture component — runs in <1ms, no simulation loop.
//
//   Drug true effect  ~  mixture of N(μᵢ, σ²ᵢ)   [from the True Effect Prior]
//   Trial noise       ~  N(0, σ²_trial)           [from trial design]
//   P(trial success)  =  Σ wᵢ · Φ((μᵢ − threshold) / √(σ²ᵢ + σ²_trial))
//
// For a 1-component mixture (the common case, and the only case unless the
// True Effect Prior has detected a genuine disagreement) this reduces EXACTLY
// to the original single-curve formula Φ((μ − threshold) / √(σ²_drug + σ²_trial)).
//
// Layer 2 output is expressed as a multiplier on the Layer 1 PTRS.
// If the trial is average for this phase/drug type → multiplier ≈ 1.0.
// Poor design (small n, single-arm, high-placebo) → multiplier < 1.0.
// Strong design (well-powered RCT, biomarker-selected, BTD) → multiplier > 1.0.
//
// ─────────────────────────────────────────────────────────────────────────────

import { type EffectPriorMixture, mixtureSuccessProbability } from "./effect-prior";

// ─── Input types ─────────────────────────────────────────────────────────────

export type EndpointType = "hard" | "surrogate" | "pro";
// hard     = OS, CR, confirmed response — low noise, high threshold
// surrogate = PFS, ORR, biomarker — moderate noise, moderate threshold
// pro      = pain, QoL, function — high noise, high placebo response

export type DesignType = "rct" | "single_arm" | "basket";
// rct        = randomized controlled — cleanest signal
// single_arm = vs. historical control — adds uncertainty
// basket     = multi-tumor / umbrella — heterogeneity adds noise

export type PopulationType = "biomarker_selected" | "broad" | "rare_small";
// biomarker_selected = enriched for target — lower σ²_drug, higher μ
// broad              = unselected — baseline
// rare_small         = rare disease, pool <5,000 pts — underpowering risk

export type PlaceboResponse = "low" | "moderate" | "high";
// low      = hard oncology, rare disease — minimal noise
// moderate = autoimmune, mild/moderate disease — adds uncertainty
// high     = CNS, pain, depression, IBS — major noise source

export type RegulatoryContext =
  | "standard"
  | "btd"
  | "orphan"
  | "btd_orphan"
  | "accelerated"
  | "confirmatory";

export type TrialDesignInputs = {
  n: number;                         // enrollment / sample size
  endpointType: EndpointType;
  designType: DesignType;
  populationType: PopulationType;
  placeboResponse: PlaceboResponse;
  regulatoryContext: RegulatoryContext;
  nctId?: string;                    // for provenance
  endpointDescription?: string;      // raw text for display
  enrollmentNote?: string;           // e.g. "36 enrolled, rare disease"
};

export type TrialRiskFlag = {
  severity: "high" | "medium" | "info";
  message: string;
};

export type Layer2Result = {
  // Core outputs
  trialSuccessProb: number;   // Σ wᵢ·Φ(zᵢ) — probability this specific trial detects the effect
  componentSuccessProbs: number[]; // Φ(zᵢ) per mixture component — for Bayesian weight updates downstream
  sigma2Trial: number;        // total trial noise component
  layer2Multiplier: number;   // how much Layer 2 adjusts Layer 1 PTRS
  layer2Delta: number;        // additive delta on PTRS (for display)

  // Combined result
  ptrsCombined: number;       // Layer 1 PTRS × layer2Multiplier
  ptrsCI: { lower: number; upper: number };

  // Explanation
  riskFlags: TrialRiskFlag[];
  inputs: TrialDesignInputs;
  summary: string;
};

// ─── Parameter tables ─────────────────────────────────────────────────────────
// Each multiplier adjusts σ²_trial. >1.0 = more noise = harder to detect effect.

const ENDPOINT_NOISE: Record<EndpointType, number> = {
  hard:      0.80,  // concrete, objective, low measurement error
  surrogate: 1.00,  // baseline reference
  pro:       1.45,  // subjective, high placebo response, regression to mean
};

const DESIGN_NOISE: Record<DesignType, number> = {
  rct:        1.00,  // randomization removes confounding
  single_arm: 1.35,  // historical control uncertainty
  basket:     1.55,  // heterogeneity across tumor types / arms
};

const POPULATION_NOISE: Record<PopulationType, number> = {
  biomarker_selected: 0.75,  // enriched — less inter-patient variance
  broad:              1.00,
  rare_small:         1.20,  // small n inflates variance even for same n
};

const PLACEBO_NOISE: Record<PlaceboResponse, number> = {
  low:      0.90,
  moderate: 1.20,
  high:     1.65,
};

// Regulatory context adjusts the evidentiary threshold — lower = easier to succeed.
// Confirmatory (post-AA) raises it because FDA wants robust proof.
const THRESHOLD_ADJUSTMENT: Record<RegulatoryContext, number> = {
  standard:     0.00,
  btd:         -0.08,
  orphan:      -0.06,
  btd_orphan:  -0.13,
  accelerated: -0.10,
  confirmatory: +0.15,
};

// ─── Scoring engine ───────────────────────────────────────────────────────────

// Reference trial: n=100 RCT, surrogate endpoint, broad population, low placebo,
// standard regulatory. Used to normalize the multiplier so average design → 1.0.
const NEUTRAL_SIGMA2_TRIAL = 1.0;   // σ²_trial for the reference trial at n=100
const BASE_THRESHOLD = 0.80;        // evidentiary bar (in μ units)

/**
 * Pure trial-design → (σ²_trial, threshold) calculation, extracted so other
 * modules (e.g. the Early-Signal Resolver sizing in lib/decision-analysis.ts)
 * can reuse the exact same noise/threshold numbers as scoreLayer2() without
 * duplicating the formula.
 */
export function computeTrialNoise(inputs: TrialDesignInputs): { sigma2Trial: number; threshold: number } {
  const { n, endpointType, designType, populationType, placeboResponse, regulatoryContext } = inputs;

  // σ²_trial: noise from trial design
  // Base noise scales inversely with n (n=100 → 1.0, n=36 → 2.78, n=200 → 0.5)
  const nBase = Math.max(n, 5);
  const noiseFromN = NEUTRAL_SIGMA2_TRIAL * (100 / nBase);
  const sigma2Trial =
    noiseFromN *
    ENDPOINT_NOISE[endpointType] *
    DESIGN_NOISE[designType] *
    POPULATION_NOISE[populationType] *
    PLACEBO_NOISE[placeboResponse];

  // Threshold: evidentiary bar adjusted for regulatory context
  const threshold = BASE_THRESHOLD + THRESHOLD_ADJUSTMENT[regulatoryContext];

  return { sigma2Trial, threshold };
}

export function scoreLayer2(
  // Drug effect-strength mixture from the True Effect Prior (1 component = normal case)
  mixture: EffectPriorMixture,
  ptrsLayer1: number,
  ciHalfWidth: number,
  // Trial design
  inputs: TrialDesignInputs,
): Layer2Result {
  const { n, endpointType, designType, populationType, placeboResponse, regulatoryContext } = inputs;

  const { sigma2Trial, threshold } = computeTrialNoise(inputs);

  // Per-component P(trial success) — Φ((μᵢ − threshold) / √(σ²ᵢ + σ²_trial)) —
  // plus the mixture-weighted overall probability (Σ wᵢ·Φᵢ).
  const componentSuccessProbs = mixture.map(({ mu, sigma2 }) =>
    normalCDF((mu - threshold) / Math.sqrt(Math.max(sigma2, 0) + sigma2Trial))
  );
  const trialSuccessProb = mixtureSuccessProbability(mixture, threshold, sigma2Trial);

  // Neutral reference: MSS=0.5, variance=0.3, n=100, rct, surrogate, broad, low, standard.
  // Deliberately a FIXED reference point (NOT mixture- or trial-design-aware) —
  // the multiplier below compares THIS drug+trial to a neutral drug in a
  // neutral trial, not this drug vs. neutral under its own trial design.
  const zNeutral = (1.0 - BASE_THRESHOLD) / Math.sqrt(0.3 + NEUTRAL_SIGMA2_TRIAL * ENDPOINT_NOISE.surrogate * DESIGN_NOISE.rct * POPULATION_NOISE.broad * PLACEBO_NOISE.low);
  const phiNeutral = normalCDF(zNeutral);

  // Multiplier: how much this trial design deviates from the reference
  // Capped to prevent extreme swings — Layer 2 is an adjustment, not a replacement
  const rawMultiplier = trialSuccessProb / phiNeutral;
  const layer2Multiplier = clamp(rawMultiplier, 0.55, 1.50);

  // Combined PTRS
  const ptrsCombined = clamp01(ptrsLayer1 * layer2Multiplier);
  const layer2Delta = ptrsCombined - ptrsLayer1;

  // CI — widen slightly when trial design adds uncertainty
  const ciMult = sigma2Trial > 2 ? 1.3 : sigma2Trial > 1 ? 1.15 : 1.0;
  const ptrsCI = {
    lower: Math.max(0.01, ptrsCombined - ciHalfWidth * ciMult),
    upper: Math.min(0.99, ptrsCombined + ciHalfWidth * ciMult),
  };

  // Risk flags
  const riskFlags: TrialRiskFlag[] = [];

  if (n < 30) riskFlags.push({ severity: "high", message: `Very small trial (n=${n}) — likely underpowered for moderate effect sizes.` });
  else if (n < 60) riskFlags.push({ severity: "medium", message: `Small trial (n=${n}) — may be underpowered unless effect size is large.` });

  if (designType === "single_arm") riskFlags.push({ severity: "medium", message: "Single-arm design: historical control comparison adds uncertainty vs. RCT." });
  if (designType === "basket") riskFlags.push({ severity: "medium", message: "Basket/umbrella design: tumor heterogeneity may dilute signal across arms." });

  if (endpointType === "pro") riskFlags.push({ severity: "high", message: "PRO/subjective endpoint: high placebo response and measurement variability — common cause of Phase 3 failure." });

  if (placeboResponse === "high") riskFlags.push({ severity: "high", message: "High placebo response indication — CNS/pain trials have historically failed due to placebo effect overwhelming drug signal." });
  else if (placeboResponse === "moderate") riskFlags.push({ severity: "medium", message: "Moderate placebo response — ensure adequate powering to separate drug effect from placebo." });

  if (regulatoryContext === "btd" || regulatoryContext === "btd_orphan") riskFlags.push({ severity: "info", message: "Breakthrough Therapy Designation lowers evidentiary threshold and enables accelerated approval pathway." });
  if (regulatoryContext === "orphan" || regulatoryContext === "btd_orphan") riskFlags.push({ severity: "info", message: "Orphan Drug Designation: smaller n is acceptable; FDA is more flexible on endpoint surrogates." });
  if (regulatoryContext === "confirmatory") riskFlags.push({ severity: "high", message: "Confirmatory study (post-accelerated approval): higher evidentiary bar — traditional endpoints required." });

  if (populationType === "biomarker_selected") riskFlags.push({ severity: "info", message: "Biomarker-selected population: enrichment reduces inter-patient variance and raises expected response rate." });
  if (populationType === "rare_small") riskFlags.push({ severity: "medium", message: "Small patient pool: power constraints accepted by regulators, but replication is difficult if trial fails." });

  // Summary
  const designLabel = designType === "rct" ? "RCT" : designType === "single_arm" ? "single-arm" : "basket/umbrella";
  const regLabel = { standard: "", btd: " + BTD", orphan: " + Orphan", btd_orphan: " + BTD + Orphan", accelerated: " + Accelerated Approval", confirmatory: " + Confirmatory" }[regulatoryContext];
  const summary =
    `Trial design: ${designLabel}, n=${n}, ${endpointType} endpoint, ${populationType.replace("_", " ")} population${regLabel}. ` +
    `Trial noise (σ²=${sigma2Trial.toFixed(2)}), P(trial success)=${(trialSuccessProb * 100).toFixed(0)}%. ` +
    `Layer 2 multiplier: ${layer2Multiplier.toFixed(2)}× → PTRS ${layer2Delta >= 0 ? "+" : ""}${(layer2Delta * 100).toFixed(1)}% vs. Layer 1.`;

  return { trialSuccessProb, componentSuccessProbs, sigma2Trial, layer2Multiplier, layer2Delta, ptrsCombined, ptrsCI, riskFlags, inputs, summary };
}

// ─── Normal CDF (Abramowitz & Stegun approximation) — pure JS, no imports ────
// Max error: 7.5e-8. Sufficient for PTRS purposes.

function normalCDF(z: number): number {
  if (z < -6) return 0;
  if (z > 6) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))));
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
  return z >= 0 ? 1 - phi : phi;
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clamp(x: number, min: number, max: number) { return Math.max(min, Math.min(max, x)); }
