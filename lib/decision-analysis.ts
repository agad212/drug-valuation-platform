// ─── Decision Analysis Engine ─────────────────────────────────────────────────
//
// Computes expected value metrics for 2–4 strategic options, all relative
// to a base valuation (Option A = current plan).
//
// Key outputs per option:
//   eNPV   = PTRS × RevenuePV − DevCostPV
//   eROI   = eNPV / DevCostPV
//   Marginal eROI = ΔeNPV / |ΔDevCost| vs Option A
//
// This engine is pure math — no API calls. It reuses:
//   scoreLayer2()     from ./ptrs-trial    (PTRS recalculation with new trial design)
//   computeRevenuePV() from ./cashflow     (revenue DCF with adjusted peak sales)
//
// ─────────────────────────────────────────────────────────────────────────────

import { scoreLayer2, computeTrialNoise } from "./ptrs-trial";
import { computeRevenuePV } from "./cashflow";
import { mixtureFromMssVariance, mixtureSuccessProbability, mixtureMoments, enrichEffectPrior, resolveEnrichmentLift, DEFAULT_ENRICHMENT_LIFT, MAX_ENRICHMENT_LIFT } from "./effect-prior";
import { computeDevPlan, resolveRegAcceptanceLevel } from "./dev-plan";
import {
  deriveMarket, calibrateBaseMarket, deriveEnrichedNiche,
  NICHE_PRICE_DEFAULT_USD, NICHE_SHARE_DEFAULT_PCT, BIOMARKER_PREVALENCE_DEFAULT,
  NICHE_WAC_BAND_USD, NICHE_SHARE_BAND_PCT,
  type MarketParams, type BaseMarket,
} from "./market-model";
import type {
  TrialDesignInputs,
  EndpointType,
  DesignType,
  PopulationType,
  PlaceboResponse,
  RegulatoryContext,
} from "./ptrs-trial";
import type { EffectPrior, ClassStatus } from "./effect-prior";
import type { DevPlanResult, DevStageInput, RegAcceptanceObservables } from "./dev-plan";
import type { Valuation } from "./types";

// ─── Option Input Types ───────────────────────────────────────────────────────

// The category of strategic change this option represents.
// Multiple categories can apply to one option.
export type OptionCategory =
  | "trial_design"
  | "population"
  | "indication"
  | "voi"
  | "partnership";

// Everything is optional — unset fields inherit from the base valuation.
// Only fill in what changes vs Option A.
export type OptionInputs = {
  id: string;
  name: string;                      // user label, e.g. "Biomarker-first RCT"
  categories?: OptionCategory[];
  isBaseline?: boolean;              // true = Option A (auto-generated)

  // ── Category 1: Trial Design ──────────────────────────────────────────────
  n?: number;                        // sample size
  endpointType?: EndpointType;       // "hard" | "surrogate" | "pro"
  // Registration-endpoint acceptability signals for the graded reg-confidence model.
  // "CONFIRMED" = FDA-accepted/precedented basis; "INFERRED" = novel/unvalidated surrogate.
  // The observables below RESOLVE the acceptance level (L1–L4); leave them unset when
  // unconfirmable → the engine FLAGS (worst level), never a silent middle rung.
  endpointEvidenceBasis?: "CONFIRMED" | "INFERRED";
  fdaGuidanceForEndpoint?: boolean;                              // FDA guidance endorses this endpoint as an approval basis
  priorFullApprovalsOnEndpoint?: "none" | "one_or_two" | "many"; // full (non-accelerated) approvals on this endpoint
  acceleratedOnlyPrecedent?: boolean;                            // approvals on it exist ONLY via accelerated approval
  approvedInClassOnEndpoint?: boolean;                           // an in-class agent was approved on this endpoint
  // G2 Phase 2a: sourced native-scale continuous stats for the CURRENT-trial (stage-0)
  // endpoint. Set BOTH for a continuous endpoint → engine uses native two-sample power;
  // omit → proportion path. Precision only; the effect stays in the prior.
  outcomeSd?: number;                // outcome SD on the endpoint's native scale
  mdeOrExpectedDelta?: number;       // expected effect Δ on the same native scale
  designType?: DesignType;           // "rct" | "single_arm" | "basket"
  numArms?: 1 | 2 | 3 | "adaptive"; // explicit arm count (affects cost; maps to designType)
  populationType?: PopulationType;   // "biomarker_selected" | "broad" | "rare_small"
  placeboResponse?: PlaceboResponse; // "low" | "moderate" | "high"
  regulatoryContext?: RegulatoryContext;

  // ── Comparator (2a): the efficacy BAR the trial must clear ─────────────────
  // "active" = must beat an efficacious active control (nintedanib, an active SOC),
  // a materially HARDER bar than placebo/saline → lower P(trial success). Flows into
  // the gating stage's nullResponseRate in the engine recompute (the same lever the
  // "harder bar" what-if uses), so P falls out of the engine, not a guess.
  comparatorType?: "placebo" | "active";
  nullResponseRateOverride?: number; // explicit control/comparator response rate for the gating stage (0–1)

  // ── Added indications (2d): breadth is NOT free ────────────────────────────
  // Count of indications ADDED beyond the lead (a 2-indication option → 1; a 3 → 2).
  // Each added indication — typically LESS validated than the lead — lowers the
  // blended PROGRAM probability of approval: succeeding across more, less-precedented
  // indications is less likely than the focused single-indication baseline.
  addedIndicationCount?: number;
  addedIndicationsValidated?: boolean; // true = added indications carry their own precedent (smaller penalty)

  // ── Niche market ABSOLUTE parameters (Build 1b) — reasoned bottom-up, NOT factors ──
  // A niche/enriched scenario re-derives peak from its OWN absolute market parameters,
  // each reasoned from niche characteristics + real comparators (never base × factor):
  nicheEligiblePatients?: number;  // absolute eligible-patient count for the niche
  nicheAnnualPriceUsd?: number;    // absolute WAC $/yr, from precision-therapy comparators
  nichePeakSharePct?: number;      // absolute peak share %, from niche competitive dynamics
  // biomarker prevalence is a real driver of the COUNT — used only to derive the niche
  // eligible count from the base eligible pop when an absolute count isn't supplied.
  biomarkerPrevalence?: number;    // 0–1 (or >1 to broaden): eligible-pool fraction vs base
  nicheMarketBasis?: string;       // one-line basis (comp / prevalence source / labeled default)
  // WAC and peak share must each be PINNED to a NAMED comparator, or they fall back to a
  // labeled bounded default + FLAG (resolve-or-flag). A number WITHOUT its comp is treated as
  // UNSOURCED — the engine does not trust an uncited market input (same discipline as the reg
  // observables and biomarker prevalence).
  nicheWacComp?: string;           // named comparator therapy + basis for the niche annual WAC
  nicheShareComp?: string;         // named analog launch + basis for the niche peak share
  // Build 2 — effect-concentration factor for the enriched (biomarker+) population:
  // the fractional μ lift the responder subset shows vs the ITT population (pinned to
  // the drug's biomarker-subgroup data / analog precedent; labeled estimate + bounded
  // when unknown; 0 → no concentration → baseline P). Feeds enrichEffectPrior upstream.
  enrichmentEffectLift?: number;
  // Added indications' OWN re-derived markets (bottom-up), summed with the lead —
  // replaces a single LLM peakSalesMOverride for a multi-indication program.
  addedIndicationMarkets?: MarketParams[];

  // ── Category 2: Patient Selection ─────────────────────────────────────────
  // Inclusion criteria tightness affects both PTRS (via population noise)
  // AND peak sales (via label breadth).
  inclusionCriteria?: "tight" | "standard" | "broad";

  // ── Category 4: VOI (Value of Information) ────────────────────────────────
  // "Run a smaller study first, then decide whether to proceed."
  isVOI?: boolean;
  voiType?: "biomarker_validation" | "pilot" | "adaptive_interim" | "dose_optimization";
  voiCostM?: number;                // cost of the preliminary study ($M)
  voiMonths?: number;               // additional months added to timeline
  voiProbPositive?: number;         // P(study positive) — user's belief, 0–1
  voiPtrsBoostIfPositive?: number;  // absolute PTRS boost if study is positive (e.g. 0.08)

  // ── Category 5: Partnership ────────────────────────────────────────────────
  ownershipPct?: number;            // 0–100: % of costs AND revenues retained
  isOutlicensed?: boolean;          // true → royalty model (Licensor) instead of full ownership
  royaltyPctOverride?: number;      // override default royalty if out-licensed

  // ── Manual overrides (bypass calculation) ─────────────────────────────────
  ptrsOverride?: number;            // explicit PTRS (skip Layer 2 recalc)
  peakSalesMOverride?: number;      // explicit peak sales in $M (skip adjustment)
  devCostMOverride?: number;        // explicit dev cost in $M (skip calculation)

  // ── AI-generated metadata ─────────────────────────────────────────────────
  changesSummary?: string;          // one-line summary of what changed vs baseline
};

// ─── Base Context ─────────────────────────────────────────────────────────────
// A snapshot of the current valuation + PTRS Layer 1+2 results.
// This is Option A's parameters — all other options are computed relative to it.

export type BaseContext = {
  // From ptrsResult (Layer 1)
  mss: number;              // Mechanism Signal Strength
  variance: number;         // σ² — uncertainty in mechanism score
  ptrsLayer1: number;       // Layer 1 PTRS before trial design adjustment
  ciHalfWidth: number;      // CI half-width on PTRS

  // From /api/effect-prior — the full Gaussian-mixture effect prior, if it has
  // finished loading. Falls back to mixtureFromMssVariance(mss, variance) when
  // null (effect prior not yet generated, or generation failed).
  effectPrior?: EffectPrior | null;

  // Per-patient cost/timeline economics from the next real dev-plan stage
  // (devPlan.stages[0]) — reused at smaller scale by the Early-Signal
  // Resolver (generateBimodalVoiOption) to size its preliminary study.
  resolverEconomics?: {
    n: number;
    cpp: number;
    enrollmentRatePerMonth: number;
    treatmentObsMonths: number;
    startupCushionMonths: number;
  };

  // Full dev-plan stage inputs — used to re-run computeDevPlan per option so
  // each option's P(approval) reflects its specific trial design across all
  // stages, not just a single-stage Layer 2 scoreLayer2() call.
  devPlanInputs?: {
    stages: DevStageInput[];
    regulatoryContext: RegulatoryContext;
    regCostM?: number;
    modalityClassStatus?: ClassStatus;
  } | null;

  // Cached overall P(approval) from the base dev plan — used as Option A's
  // probability when devPlanInputs is available (keeps Option A consistent
  // with the Development Path display).
  devPlanPApproval?: number | null;

  // Cached risk-adjusted dev cost ($M) from the base dev plan — used as Option
  // A's cost so the baseline reproduces the headline eNPV. The engine (not the
  // stale devCostPV or the LLM's per-option guesses) is the source of truth.
  devPlanRiskAdjCostM?: number | null;

  // From layer2Result (Layer 2) — the current trial design
  baseTrialDesign: TrialDesignInputs;

  // Base indication's bottom-up market (Build 1/1b) — TAM + penetration calibrated so
  // deriveMarket(market) === peakSalesM, plus the eligible-patient COUNT and annual WAC
  // as separate components so a niche can be reasoned against real base anchors.
  market?: BaseMarket;

  // From valuation
  ptrs: number;             // combined PTRS (Layer 1 × Layer 2)
  peakSalesM: number;       // peak sales in $M
  devCostM: number;         // dev cost in $M
  launchYear: number;
  loeYear: number;
  discountRate: number;
  cogsPct: number;
  taxRate: number;
  workingCapitalPct: number;
  avgRoyalty: number;
  ownerType: "Owner" | "Licensor";
  phase: string;
};

// ─── Option Result ─────────────────────────────────────────────────────────────
// Computed outputs for one option.

export type OptionResult = {
  option: OptionInputs;

  // Adjusted inputs
  ptrs: number;
  ptrsCI: { lower: number; upper: number };
  peakSalesM: number;
  devCostM: number;
  revenuePVM: number;         // PV of revenue stream ($M)

  // Primary outputs
  eNPVM: number;              // Expected NPV ($M) = PTRS × RevenuePV − DevCostPV
  eROI: number | null;        // eNPV / devCost (null if devCost = 0)

  // Marginal outputs vs Option A
  deltaENPVM: number | null;  // eNPV(this) − eNPV(A)
  deltaCostM: number | null;  // DevCost(this) − DevCost(A)
  marginalEROI: number | null; // ΔeNPV / |ΔCost|, with sign: + if gaining value, − if losing it

  // Risk profile (eNPV at CI extremes)
  eNPVLowM: number;
  eNPVHighM: number;

  // VOI path (if option.isVOI)
  voiENPVM?: number;          // expected value of the VOI path
  voiVsDirectM?: number;      // VOI eNPV − going straight (vs Option A)

  // Timeline (populated when resolverEconomics is available)
  durationMonths?: number;    // estimated months for this trial option

  // Explanations
  keyDrivers: string[];
  ptrsDrivers: string;

  // Structured niche-market provenance (the SOURCE OF TRUTH; the keyDriver string is only the
  // human-facing surface). The seam to the Option B critic AND to calibration backtests — both
  // need "was this sourced, to what, in band?" as queryable data, not prose. Present only when
  // the niche market was re-derived.
  nicheProvenance?: {
    wac:   { value: number; comp: string | null; sourced: boolean; inBand: boolean };
    share: { value: number; comp: string | null; sourced: boolean; inBand: boolean };
  };
};

// Resolve a niche market param under resolve-or-flag + an out-of-band clamp:
//   • cited (number + named comp) & IN band  → trust the cited value
//   • cited but OUT of band                  → clamp to the band edge + flag (citation & number
//                                              must agree; a comp alone can't vouch for any number)
//   • uncited or omitted                     → hold at the labeled BOUNDED default + flag
// Returns the USED value plus its structured provenance. Never returns a confident, unvouched value.
function resolveNicheParam(
  raw: number | undefined,
  comp: string | undefined,
  band: { min: number; max: number },
  fallback: number,
): { value: number; comp: string | null; sourced: boolean; inBand: boolean } {
  const c = comp?.trim() || null;
  if (raw != null && c) {
    const inBand = raw >= band.min && raw <= band.max;
    const value = inBand ? raw : Math.min(band.max, Math.max(band.min, raw));
    return { value, comp: c, sourced: true, inBand };
  }
  // uncited or omitted → hold at the neutral bounded default (which sits inside the band)
  return { value: fallback, comp: c, sourced: false, inBand: true };
}

// ─── Calculation Parameter Tables ─────────────────────────────────────────────

// Design complexity → cost multiplier (relative to 2-arm RCT = 1.0)
const DESIGN_COST_MULT: Record<string, number> = {
  single_arm: 0.70,   // no control arm, simpler logistics
  rct:        1.00,   // 2-arm RCT is the cost baseline
  "3arm":     1.40,   // 3-arm requires 40% more patients + sites
  adaptive:   1.30,   // adaptive adds statistical design complexity
  basket:     1.20,   // multi-basket adds heterogeneity costs
};

// REMOVED (Build 1): INCLUSION_PEAK_SALES_MULT, DESIGN_PEAK_SALES_MULT and
// POPULATION_PEAK_SALES_MULT — the peak-sales HAIRCUTS that scaled the base peak per
// scenario. They are replaced by a genuine market RE-DERIVATION (lib/market-model.ts):
// a biomarker/enriched scenario re-derives peak from a smaller eligible pool × a
// re-derived niche price × a re-derived niche penetration, so the net is CALCULATED,
// not assumed. Label/design strength now folds into the niche price/penetration drivers,
// not a flat peak multiplier. See computeOption Step 3.

// ─── Label-breadth difficulty ───────────────────────────────────────────────
//
// The dev-plan engine computes per-option P(success) from trial design + effect
// prior and is structurally blind to how much HARDER a broader regulatory label
// is to win. This restores that signal — the one the removed LLM ptrsOverride
// used to carry — but COMPUTES it from attributes the engine already has, not a
// guess. Magnitudes are chosen from regulatory reasoning, NOT tuned to a ranking.
//
//   - Pan-tumor basket design (×0.60): a tumor-agnostic MRD label has no approval
//     precedent; efficacy must hold across heterogeneous histologies and one null
//     cohort can sink the filing — materially harder than a single tumor type.
//   - Broadened / unselected population vs a selected base (×0.80): loss of
//     biomarker enrichment widens and dilutes the population.
//   - Loss of orphan designation, orphan → non-orphan (×0.88): removes a real
//     regulatory tailwind (endpoint flexibility, smaller-n acceptance).
//
// A single tightly-defined indication trips none of these → mult 1.0.
export function labelBreadthMultiplier(
  trialDesign: TrialDesignInputs,
  base: BaseContext,
): { mult: number; reasons: string[] } {
  let mult = 1.0;
  const reasons: string[] = [];

  if (trialDesign.designType === "basket") {
    mult *= 0.60;
    reasons.push("pan-tumor basket — no tumor-agnostic MRD precedent (×0.60)");
  }
  if (trialDesign.populationType === "broad" && base.baseTrialDesign.populationType !== "broad") {
    mult *= 0.80;
    reasons.push("broadened/unselected population (×0.80)");
  }
  const baseOrphan = base.baseTrialDesign.regulatoryContext.includes("orphan");
  const optOrphan = trialDesign.regulatoryContext.includes("orphan");
  if (baseOrphan && !optOrphan) {
    mult *= 0.88;
    reasons.push("orphan designation lost (×0.88)");
  }
  return { mult, reasons };
}

// Active comparator raises the efficacy bar (must beat an efficacious control, not
// placebo/saline). Modelled as an additive lift to the gating stage's control
// response rate — the SAME lever the "harder bar" what-if uses — so it flows through
// the engine's threshold math to a LOWER P(trial success). A caller-supplied
// nullResponseRateOverride (the real control rate) takes precedence over this default.
const ACTIVE_COMPARATOR_NULL_BUMP = 0.15;

// ─── Program-breadth difficulty (added indications) ─────────────────────────
//
// Breadth is NOT free: a multi-indication option must succeed across MORE — and
// typically LESS-validated — indications than the focused baseline, so its blended
// PROGRAM probability of approval is LOWER, not equal. This is a deterministic
// per-added-indication multiplier (regulatory reasoning, not tuned to a ranking):
//   - each added LESS-validated indication ×0.80 (own evidence/class less precedented)
//   - each added VALIDATED indication      ×0.92 (carries its own precedent)
// A single-indication option (count 0) → ×1.0. The multiplier only ever LOWERS P,
// so a broad platform can never show the same/higher P than the single-indication base.
export function programBreadthMultiplier(option: OptionInputs): { mult: number; reasons: string[] } {
  const count = Math.max(0, Math.trunc(option.addedIndicationCount ?? 0));
  if (count === 0) return { mult: 1.0, reasons: [] };
  const per = option.addedIndicationsValidated ? 0.92 : 0.80;
  const mult = Math.pow(per, Math.min(count, 3)); // cap the compounding at 3 added
  return {
    mult,
    reasons: [`+${count} ${option.addedIndicationsValidated ? "validated" : "less-validated"} indication(s) — blended program P ×${mult.toFixed(2)} (breadth is not free)`],
  };
}

// ─── Canonical biomarker-enrichment predicate (Build 2, patched) ────────────────
// "Is this option a BIOMARKER / defined-RESPONDER enrichment?" — the signal that
// concentrates the EFFECT and therefore shifts the effect prior (μ↑/σ² tighter).
// BIOMARKER-SPECIFIC signals ONLY. inclusionCriteria:"tight" is DELIBERATELY excluded:
// generic narrowing (severity / line-of-therapy / age / geography) shrinks the eligible
// COUNT (a market effect) but does NOT concentrate the effect, so it must never raise μ
// — otherwise any tight option gets a free effect lift through the integral. The market
// re-derivation still responds to inclusionCriteria (count) separately; the two axes
// agree on ENRICHMENT but stop treating generic tightness as enrichment. Broadening
// (populationType "broad" / prevalence ≥ 1) is excluded.
export function isBiomarkerEnriched(option: OptionInputs): boolean {
  return option.populationType === "biomarker_selected"
    || option.enrichmentEffectLift != null
    || (option.biomarkerPrevalence != null && option.biomarkerPrevalence < 1);
}

// ─── Core Calculation ─────────────────────────────────────────────────────────

export function computeOption(
  base: BaseContext,
  option: OptionInputs,
  optionA?: OptionResult,  // pass undefined when computing Option A itself
): OptionResult {

  // ── Step 1: Resolve trial design inputs (option overrides base) ────────────
  // G2 Phase 2a: carry the current-trial continuous stats (option-overridable). Both must
  // resolve to a positive number for the engine to use native continuous power; else omitted
  // → proportion path (identical to today).
  const resolvedOutcomeSd = option.outcomeSd ?? base.baseTrialDesign.outcomeSd;
  const resolvedMde = option.mdeOrExpectedDelta ?? base.baseTrialDesign.mdeOrExpectedDelta;
  const trialDesign: TrialDesignInputs = {
    n:                 option.n                ?? base.baseTrialDesign.n,
    endpointType:      option.endpointType     ?? base.baseTrialDesign.endpointType,
    designType:        option.designType       ?? base.baseTrialDesign.designType,
    populationType:    option.populationType   ?? base.baseTrialDesign.populationType,
    placeboResponse:   option.placeboResponse  ?? base.baseTrialDesign.placeboResponse,
    regulatoryContext: option.regulatoryContext ?? base.baseTrialDesign.regulatoryContext,
    nctId:              base.baseTrialDesign.nctId,
    endpointDescription: base.baseTrialDesign.endpointDescription,
    enrollmentNote:     base.baseTrialDesign.enrollmentNote,
    ...(resolvedOutcomeSd != null ? { outcomeSd: resolvedOutcomeSd } : {}),
    ...(resolvedMde != null ? { mdeOrExpectedDelta: resolvedMde } : {}),
  };

  // ── Step 2: Adjusted PTRS (+ per-option engine cost) ──────────────────────
  // When a dev plan governs, the ENGINE is the single source of truth for BOTH
  // P(approval) and risk-adjusted cost, computed per this option's design. The
  // LLM's ptrsOverride / devCostMOverride are ignored in that path — they were
  // guesses that made the advisor diverge from the headline. peakSalesMOverride
  // is still honored (market size is the revenue model's job, not the engine's).
  let ptrs: number;
  let ptrsCI: { lower: number; upper: number };
  let enginePlanCostM: number | null = null;  // per-option risk-adjusted cost when the engine ran
  let priorShiftDriver: string | null = null; // Build 2: biomarker enrichment prior-shift audit line
  let regDriver: string | null = null;         // Build 3: evidence-derived reg-confidence audit line
  let continuousDriver: string | null = null;  // G2 Phase 2a: continuous native-power audit line (read-only)
  const hasDevPlan = !!base.devPlanInputs?.stages?.length;
  const ciBand = (p: number) => ({
    lower: Math.max(0.01, p - base.ciHalfWidth),
    upper: Math.min(0.99, p + base.ciHalfWidth),
  });

  if (option.ptrsOverride != null && !hasDevPlan) {
    // No dev plan → honor the explicit override.
    ptrs = clamp01(option.ptrsOverride);
    ptrsCI = ciBand(ptrs);
  } else if (option.isBaseline && base.devPlanPApproval != null) {
    // Option A: reuse the headline dev plan's P(approval) AND its risk-adjusted
    // cost, so the baseline reproduces the Development Path eNPV exactly.
    ptrs = base.devPlanPApproval;
    ptrsCI = ciBand(ptrs);
    enginePlanCostM = base.devPlanRiskAdjCostM ?? null;
  } else if (hasDevPlan) {
    // Re-run the full multi-stage development plan with this option's trial
    // design replacing stage 0 — the correct multi-stage P(approval) AND the
    // bottom-up risk-adjusted cost for THIS option's design.
    const mixture = base.effectPrior?.mixture ?? mixtureFromMssVariance(base.mss, base.variance);
    // ── Biomarker enrichment (base re-pin — unified per-stage) ───────────────────
    // When the option enriches to a defined-responder population (and the base isn't already
    // biomarker-selected), we mark the CURRENT-trial (stage-0) stage so computeDevPlan shifts
    // THAT stage's prior (enrichEffectPrior μ↑/σ² tighter) — the SAME per-stage mechanism the
    // base now uses. We NO LONGER enrich the whole mixture upstream: that propagated the
    // subgroup concentration into later broad stages (a biomarker Ph2 wrongly de-risking a
    // broad Ph3). Enrichment is confined to the enriched stage; later broad stages run on the
    // un-enriched belief. Lift comes from the shared resolveEnrichmentLift (no reimplementation).
    const enrichable = isBiomarkerEnriched(option) && base.baseTrialDesign.populationType !== "biomarker_selected";
    const enrichmentLift = enrichable
      ? resolveEnrichmentLift({ prevalence: option.biomarkerPrevalence, explicitLift: option.enrichmentEffectLift }).lift
      : 0;
    if (enrichable && enrichmentLift > 0) {
      // Display-only preview of the stage-0 shift (deterministic; matches what computeDevPlan
      // applies to that stage). It does NOT enrich the propagated mixture.
      const before = mixtureMoments(mixture);
      const after = mixtureMoments(enrichEffectPrior(mixture, enrichmentLift));
      priorShiftDriver =
        `Biomarker enrichment → effect prior shifted on the enriched stage (μ ${(before.mss * 2).toFixed(2)}→${(after.mss * 2).toFixed(2)}, ` +
        `σ² ${before.variance.toFixed(2)}→${after.variance.toFixed(2)}; lift ×${(1 + enrichmentLift).toFixed(2)}` +
        `${option.enrichmentEffectLift == null ? ", grounded default" : ""}) → higher P via the integral, confined to this stage`;
    }
    // Comparator (2a): route an active-comparator harder bar into the gating stage's
    // control response rate so the engine recomputes a LOWER P from it. Explicit
    // override wins; else an "active" comparator lifts the base stage's nullResponseRate.
    const baseStage0 = base.devPlanInputs!.stages[0] as DevStageInput;
    const baseNull = baseStage0.nullResponseRate ?? 0.15; // phase-2 default floor when the stage has none
    const comparatorNull =
      option.nullResponseRateOverride != null
        ? clamp01(option.nullResponseRateOverride)
        : (option.comparatorType === "active"
            ? Math.min(0.9, baseNull + ACTIVE_COMPARATOR_NULL_BUMP)
            : undefined);
    // Carry the RESOLVED enrichment lift (incl. 0) onto stage-0 so computeDevPlan enriches THAT
    // stage per-stage (non-propagating) by that exact amount — and FORCE populationType back to
    // base so the stage's population can't independently re-trigger a DEFAULT enrichment inside
    // computeDevPlan. This makes f=0 genuinely zeroable (no lift → baseline P), and keeps the
    // explicit lift the single enrichment channel. Enrichment is the μ-shift, not a POP flip
    // (POP_N_FACTOR retired), so cost/other stay unaffected.
    const recomputeTrialDesign = enrichable
      ? { ...trialDesign, populationType: base.baseTrialDesign.populationType, enrichmentEffectLift: enrichmentLift }
      : trialDesign;
    const stage0Override: DevStageInput = {
      ...baseStage0,
      n: trialDesign.n,
      trialDesign: recomputeTrialDesign,
      ...(comparatorNull != null ? { nullResponseRate: comparatorNull } : {}),
    };
    // ── Regulatory acceptability (scenario-only, graded): if this option CHANGES the
    // registration endpoint (type, evidence basis, or any acceptance observable) vs the
    // base registration trial, route the evidence-derived reg gate via regEndpoint. When
    // unchanged, omit it so the flat REG_APPROVAL_PROB base rate governs (== baseline).
    const planStages = base.devPlanInputs!.stages as DevStageInput[];
    const regStageInput = planStages[planStages.length - 1]; // registration (last) trial
    const baseRegEndpointType = regStageInput.trialDesign.endpointType;
    const baseRegEndpointBasis = regStageInput.endpointEvidenceBasis;
    const optRegEndpointType = option.endpointType ?? baseRegEndpointType;
    const optRegEndpointBasis = option.endpointEvidenceBasis ?? baseRegEndpointBasis;
    const optAssertsAcceptanceObs =
      option.fdaGuidanceForEndpoint != null || option.priorFullApprovalsOnEndpoint != null ||
      option.acceleratedOnlyPrecedent != null || option.approvedInClassOnEndpoint != null;
    const regEndpointChanged =
      optRegEndpointType !== baseRegEndpointType ||
      optRegEndpointBasis !== baseRegEndpointBasis ||
      optAssertsAcceptanceObs;
    const regEndpoint: RegAcceptanceObservables | undefined = regEndpointChanged
      ? {
          endpointType: optRegEndpointType,
          ...(optRegEndpointBasis != null ? { endpointEvidenceBasis: optRegEndpointBasis } : {}),
          ...(option.fdaGuidanceForEndpoint != null ? { fdaGuidanceForEndpoint: option.fdaGuidanceForEndpoint } : {}),
          ...(option.priorFullApprovalsOnEndpoint != null ? { priorFullApprovalsOnEndpoint: option.priorFullApprovalsOnEndpoint } : {}),
          ...(option.acceleratedOnlyPrecedent != null ? { acceleratedOnlyPrecedent: option.acceleratedOnlyPrecedent } : {}),
          ...(option.approvedInClassOnEndpoint != null ? { approvedInClassOnEndpoint: option.approvedInClassOnEndpoint } : {}),
        }
      : undefined;
    const fullPlan = computeDevPlan(
      mixture,
      base.ciHalfWidth,
      {
        stages: [stage0Override, ...base.devPlanInputs!.stages.slice(1)],
        regulatoryContext: base.devPlanInputs!.regulatoryContext,
        regCostM: base.devPlanInputs!.regCostM,
        modalityClassStatus: base.devPlanInputs!.modalityClassStatus,
        ...(regEndpoint ? { regEndpoint } : {}),
      },
      0, // revenuePVM not needed — we use pApproval + totalRiskAdjCostM
    );
    ptrs = fullPlan.pApproval;
    ptrsCI = ciBand(ptrs);
    enginePlanCostM = fullPlan.totalRiskAdjCostM;
    // G2 Phase 2a display (READ-ONLY): when the current-trial stage carries sourced continuous
    // stats, computeDevPlan ran native two-sample z-power on it (same gate: both stats > 0).
    // Surface the inputs the engine used so the path is visible in the advisor. This RE-STATES
    // already-resolved inputs — SD, Δ, n — and the standardized effect d = Δ/SD (the
    // calibration's prior-mean anchor, matching the engine's dScale). It recomputes NO power
    // and changes NO number (ptrs/eNPV above are untouched).
    if (resolvedOutcomeSd != null && resolvedOutcomeSd > 0 && resolvedMde != null && resolvedMde > 0) {
      const dRef = resolvedMde / resolvedOutcomeSd;
      continuousDriver =
        `Continuous endpoint: SD ${resolvedOutcomeSd} / Δ ${resolvedMde} (native scale) → d ${dRef.toFixed(2)}; ` +
        `native two-sample z-power at n ${trialDesign.n} (not the response-rate proxy)`;
    }
    if (regEndpoint) {
      const { level, flagged } = resolveRegAcceptanceLevel(regEndpoint);
      const LEVEL_LABEL: Record<typeof level, string> = {
        L1_precedented_outcome: "precedented clinical outcome",
        L2_validated_surrogate: "validated surrogate",
        L3_thin_precedent:      "thin / accelerated-only precedent",
        L4_no_precedent:        "no-precedent / novel",
        held_unconfirmed:       "unconfirmed — held at base rate",
      };
      regDriver =
        `Reg acceptability (evidence-derived — ${LEVEL_LABEL[level]}${flagged ? " ⚠ UNCONFIRMED" : ""}): ` +
        `registration endpoint ${optRegEndpointType} → ` +
        `P(approve|success) ${(fullPlan.regStage.pApproval * 100).toFixed(0)}% (endpoint acceptability, not trial power)`;
    }
  } else if (option.isBaseline) {
    // Fallback when dev plan not yet computed — use stored combined PTRS.
    ptrs = base.ptrs;
    ptrsCI = ciBand(ptrs);
  } else {
    // Fallback: single-stage Layer 2 score (used when dev plan not available)
    const mixture = base.effectPrior?.mixture ?? mixtureFromMssVariance(base.mss, base.variance);
    const l2 = scoreLayer2(mixture, base.ptrsLayer1, base.ciHalfWidth, trialDesign);
    ptrs = l2.ptrsCombined;
    ptrsCI = l2.ptrsCI;
  }

  // ── Step 2b: Label-breadth difficulty ─────────────────────────────────────
  // The engine's trial-design P(success) is blind to REGULATORY difficulty of a
  // broader label (it only sees n / design / prior). Restore that signal — the
  // one the now-removed LLM ptrsOverride used to carry — but COMPUTE it from the
  // option's own attributes, not a guess. A single tightly-defined indication is
  // untouched; a pan-tumor basket / broadened / de-orphaned ask is penalized.
  const breadth = labelBreadthMultiplier(trialDesign, base);
  if (!option.isBaseline && breadth.mult < 1) {
    ptrs = clamp01(ptrs * breadth.mult);
    ptrsCI = ciBand(ptrs);
  }

  // ── Step 2c: Program-breadth difficulty (added indications) ────────────────
  // Breadth is NOT free (2d): a multi-indication option's blended PROGRAM P must be
  // LOWER than the focused baseline. Applied after the engine P so the added, less-
  // validated indications drag the blended probability down — the added market
  // (peakSalesMOverride) is therefore credited only at this reduced probability.
  const programBreadth = programBreadthMultiplier(option);
  if (!option.isBaseline && programBreadth.mult < 1) {
    ptrs = clamp01(ptrs * programBreadth.mult);
    ptrsCI = ciBand(ptrs);
  }

  // ── Step 3: Peak sales — RE-DERIVE the market, don't haircut the peak (Build 1) ─
  // A scenario market change pushes UPSTREAM to the market drivers (eligible pool,
  // price, penetration) and lets the market model compute the consequence; it is NOT
  // a multiplier on the base peak. The base market is calibrated so deriveMarket(base)
  // === base.peakSalesM, so Option A / no market change reproduces the base exactly.
  let peakSalesM: number;
  const marketDrivers: string[] = [];
  let nicheProvenance: OptionResult["nicheProvenance"];
  const baseMarket: BaseMarket = base.market ?? calibrateBaseMarket(base.peakSalesM);

  if (option.peakSalesMOverride != null) {
    // Explicit escape hatch — a user/LLM-supplied peak substitutes the market model.
    peakSalesM = option.peakSalesMOverride;
  } else if (option.isBaseline) {
    peakSalesM = base.peakSalesM; // Option A reproduces the base peak
  } else {
    // Detect a niche/market-changing scenario and RE-DERIVE it BOTTOM-UP from the niche's
    // OWN absolute parameters (Build 1b) — an eligible COUNT × an absolute WAC × an
    // absolute peak share. None of these is a factor on the base peak, so the niche peak
    // is INDEPENDENT of the base peak (the decoupling property proven in the tests).
    const explicitNicheParams =
      option.nicheEligiblePatients != null || option.nicheAnnualPriceUsd != null || option.nichePeakSharePct != null;
    // The MARKET (count/price/share) responds to biomarker enrichment AND to generic
    // inclusion tightening (severity/line/age/geography) — both change the eligible pool.
    // The prior-shift (P) is gated on isBiomarkerEnriched ONLY, so generic tightness moves
    // the market but NOT μ. Enrichment still moves both; they agree on enrichment.
    const marketChanging = isBiomarkerEnriched(option) || option.inclusionCriteria === "tight";

    if (explicitNicheParams || marketChanging) {
      // Eligible COUNT: an explicit absolute wins; else derive it from the base eligible
      // pop × the biomarker prevalence (prevalence is a real driver of the COUNT — allowed).
      const nicheEligiblePatients =
        option.nicheEligiblePatients
        ?? (baseMarket.eligiblePatients != null
              ? baseMarket.eligiblePatients * (option.biomarkerPrevalence ?? BIOMARKER_PREVALENCE_DEFAULT)
              : null);

      if (nicheEligiblePatients != null) {
        // Price and share must each be PINNED to a NAMED comparator (nicheWacComp / nicheShareComp)
        // AND land inside the heuristic band. resolveNicheParam enforces resolve-or-flag: cited-in-band
        // → trust; cited-out-of-band → clamp + flag; uncited/omitted → labeled BOUNDED default + flag.
        // Same discipline as the reg observables and biomarker prevalence. NEVER base price × premium
        // or base penetration × mult. (The market MATH below is unchanged; only where WAC and share
        // COME FROM is gated — deriveEnrichedNiche receives the resolved values.)
        const wac   = resolveNicheParam(option.nicheAnnualPriceUsd, option.nicheWacComp,   NICHE_WAC_BAND_USD,   NICHE_PRICE_DEFAULT_USD);
        const share = resolveNicheParam(option.nichePeakSharePct,   option.nicheShareComp, NICHE_SHARE_BAND_PCT, NICHE_SHARE_DEFAULT_PCT);
        nicheProvenance = { wac, share };
        const niche = deriveEnrichedNiche({ nicheEligiblePatients, nicheAnnualPriceUsd: wac.value, nichePeakSharePct: share.value });
        peakSalesM = niche.peakSalesM;
        const wacStr = wac.sourced
          ? (wac.inBand
              ? `WAC $${(wac.value / 1000).toFixed(0)}k/yr pinned to ${wac.comp}`
              : `WAC $${(wac.value / 1000).toFixed(0)}k/yr [cited ${wac.comp} but OUT-OF-BAND → clamped to heuristic band $${NICHE_WAC_BAND_USD.min / 1000}k–$${NICHE_WAC_BAND_USD.max / 1000}k]`)
          : `WAC $${(wac.value / 1000).toFixed(0)}k/yr [UNSOURCED estimate — precision-therapy midpoint (heuristic), no comp cited]`;
        const shareStr = share.sourced
          ? (share.inBand
              ? `share ${share.value.toFixed(0)}% pinned to ${share.comp}`
              : `share ${share.value.toFixed(0)}% [cited ${share.comp} but OUT-OF-BAND → clamped to heuristic band ${NICHE_SHARE_BAND_PCT.min}–${NICHE_SHARE_BAND_PCT.max}%]`)
          : `share ${share.value.toFixed(0)}% [UNSOURCED estimate — defined-responder midpoint (heuristic), no comp cited]`;
        const sourcing = [
          wacStr,
          shareStr,
          option.nicheEligiblePatients == null
            ? `count from base eligible × prevalence ${(option.biomarkerPrevalence ?? BIOMARKER_PREVALENCE_DEFAULT)}`
            : null,
        ].filter(Boolean);
        marketDrivers.push(niche.provenance +
          (option.nicheMarketBasis ? ` — ${option.nicheMarketBasis}` : "") +
          ` [${sourcing.join("; ")}]`);
      } else {
        // No base eligible count to anchor a niche — leave the market at base rather than
        // invent a multiplier. (Persist annual WAC at auto-value to enable re-derivation.)
        peakSalesM = base.peakSalesM;
        marketDrivers.push("niche not re-derived: base eligible-patient count unavailable (persist annual WAC to enable)");
      }
    } else {
      peakSalesM = base.peakSalesM;
    }

    // Added indications (2d/#10): SUM each added indication's OWN re-derived market
    // (bottom-up) onto the lead — replaces a single LLM peakSalesMOverride lump.
    if (option.addedIndicationMarkets?.length) {
      let added = 0;
      for (const m of option.addedIndicationMarkets) added += deriveMarket(m).peakSalesM;
      peakSalesM += added;
      marketDrivers.push(`+${option.addedIndicationMarkets.length} indication market(s) summed (bottom-up) → +$${added.toFixed(0)}M`);
    }

    // Ownership/partnership scaling (legitimate share of a real market, not a scenario haircut).
    if (option.ownershipPct != null) {
      peakSalesM *= option.ownershipPct / 100;
    } else if (option.isOutlicensed && !base.ownerType.includes("Licensor")) {
      const royalty = option.royaltyPctOverride ?? base.avgRoyalty;
      peakSalesM *= royalty;
    }
  }

  // ── Step 4: Adjusted dev cost + trial duration ───────────────────────────
  let devCostM: number;
  let durationMonths: number | undefined;

  const baseN = base.baseTrialDesign.n;
  const optionN = trialDesign.n;

  // Design complexity adjustment (applies in both cost models below)
  const resolvedDesignKey = (() => {
    if (option.numArms === 3) return "3arm";
    if (option.numArms === "adaptive") return "adaptive";
    return option.designType ?? base.baseTrialDesign.designType;
  })();
  const baseDesignKey = base.baseTrialDesign.designType;
  const complexityAdjust =
    (DESIGN_COST_MULT[resolvedDesignKey] ?? 1.0) /
    (DESIGN_COST_MULT[baseDesignKey] ?? 1.0);

  // Trial duration: always computed from enrollment economics when available,
  // regardless of whether cost is overridden — cost and time are independent.
  if (base.resolverEconomics) {
    const { enrollmentRatePerMonth, treatmentObsMonths, startupCushionMonths } = base.resolverEconomics;
    durationMonths = Math.ceil(
      optionN / Math.max(enrollmentRatePerMonth, 0.1) + treatmentObsMonths + startupCushionMonths
    );
  }

  if (enginePlanCostM != null) {
    // Dev-plan engine ran for this option → use its risk-adjusted cost (single
    // source of truth, reconciles with the headline). Ignores devCostMOverride.
    devCostM = enginePlanCostM;
  } else if (option.devCostMOverride != null) {
    devCostM = option.devCostMOverride;
  } else if (base.resolverEconomics) {
    // Per-patient cost model: CPP × n for the current trial stage,
    // plus the rest of the program cost (other stages) unchanged.
    const { cpp, n: baseStageN } = base.resolverEconomics;
    const baseStageCostM = baseStageN * cpp / 1e6;
    const newStageCostM  = optionN * cpp / 1e6 * complexityAdjust;
    const otherCostM     = Math.max(0, base.devCostM - baseStageCostM);
    devCostM = otherCostM + newStageCostM;
  } else {
    // Fallback: fixed (60%) + variable (40%) scaling with n^0.75
    const fixedCost    = base.devCostM * 0.60;
    const variableCost = base.devCostM * 0.40;
    const nScale = baseN > 0 ? Math.pow(optionN / baseN, 0.75) : 1;
    devCostM = fixedCost + variableCost * nScale * complexityAdjust;
  }

  // Ownership adjustment applies to computed costs (engine or per-patient), not
  // to an explicit dollar override (which is assumed to already reflect it).
  if (enginePlanCostM != null || option.devCostMOverride == null) {
    if (option.ownershipPct != null) {
      devCostM *= option.ownershipPct / 100;
    } else if (option.isOutlicensed) {
      devCostM *= 0.05;
    }
  }

  // VOI: add study cost + time value of delay
  if (option.isVOI && option.voiCostM) {
    devCostM += option.voiCostM;
    if (option.voiMonths && option.voiMonths > 0) {
      const monthlyBurn = base.devCostM / 36;
      devCostM += option.voiMonths * monthlyBurn;
    }
  }

  devCostM = Math.max(0, devCostM);

  // ── Step 5: Revenue PV ────────────────────────────────────────────────────
  // Delay launch year for VOI options
  const launchDelay = option.isVOI && option.voiMonths
    ? Math.ceil(option.voiMonths / 12)
    : 0;

  const revPVInput = {
    peakSales:            peakSalesM * 1e6,
    launchYear:           base.launchYear + launchDelay,
    loeYear:              base.loeYear + launchDelay,
    discountRate:         base.discountRate,
    cogsPct:              base.cogsPct,
    taxRate:              base.taxRate,
    workingCapitalPct:    base.workingCapitalPct,
    avgRoyalty:           option.royaltyPctOverride ?? base.avgRoyalty,
    ownerType:            option.isOutlicensed ? "Licensor" as const : base.ownerType,
  } as Valuation;

  const revenuePVM = computeRevenuePV(revPVInput) / 1e6;

  // ── Step 6: eNPV ─────────────────────────────────────────────────────────
  const eNPVM = round1(ptrs * revenuePVM - devCostM);

  // ── Step 7: eROI ─────────────────────────────────────────────────────────
  const eROI = devCostM > 0.1 ? round2(eNPVM / devCostM) : null;

  // ── Step 8: Marginal eROI vs Option A ────────────────────────────────────
  let deltaENPVM: number | null = null;
  let deltaCostM: number | null = null;
  let marginalEROI: number | null = null;

  if (optionA && !option.isBaseline) {
    deltaENPVM = round1(eNPVM - optionA.eNPVM);
    deltaCostM = round1(devCostM - optionA.devCostM);

    if (Math.abs(deltaCostM) > 0.5) {
      // Sign convention:
      //   deltaCostM > 0 (costs more): marginalEROI = ΔeNPV / ΔCost
      //   deltaCostM < 0 (saves money): marginalEROI = ΔeNPV / |ΔCost|
      //     → positive marginal means: every dollar NOT spent returns more eNPV
      marginalEROI = round2(deltaENPVM / Math.abs(deltaCostM));
    }
  }

  // ── Step 9: Risk profile (eNPV at CI bounds) ──────────────────────────────
  const eNPVLowM  = round1(ptrsCI.lower * revenuePVM - devCostM);
  const eNPVHighM = round1(ptrsCI.upper * revenuePVM - devCostM);

  // ── Step 10: VOI calculation ──────────────────────────────────────────────
  let voiENPVM: number | undefined;
  let voiVsDirectM: number | undefined;

  if (option.isVOI && option.voiProbPositive != null) {
    const pPos = option.voiProbPositive;
    const voiStudyCost = option.voiCostM ?? 0;

    // If positive: PTRS gets a boost (confirms signal) → compute eNPV of proceeding
    const ptrsIfPositive = option.voiPtrsBoostIfPositive
      ? clamp01(ptrs + option.voiPtrsBoostIfPositive)
      : clamp01(ptrs * 1.15);  // default: 15% relative boost if positive

    // eNPV of going forward after a positive study (dev cost already includes study cost)
    const eNPVIfPositive = ptrsIfPositive * revenuePVM - devCostM;

    // If negative: stop development, save remaining dev cost → eNPV = 0
    // (study cost is sunk but the larger dev cost is avoided)
    const eNPVIfNegative = 0;

    voiENPVM = round1(pPos * eNPVIfPositive + (1 - pPos) * eNPVIfNegative);

    if (optionA) {
      voiVsDirectM = round1(voiENPVM - optionA.eNPVM);
    }
  }

  // ── Step 11: Explanations ─────────────────────────────────────────────────
  const keyDrivers: string[] = [];
  // Compare against devPlan P(approval) as baseline when available — keeps
  // the probability axis consistent with the Development Path display.
  const baselinePtrs = base.devPlanPApproval ?? base.ptrs;
  const ptrsDiff = ptrs - baselinePtrs;

  if (Math.abs(ptrsDiff) > 0.005) {
    keyDrivers.push(`P(approval) ${ptrsDiff >= 0 ? "+" : ""}${(ptrsDiff * 100).toFixed(1)}% vs Option A`);
  }
  if (!option.isBaseline && breadth.mult < 1) {
    keyDrivers.push(`Label-breadth: ${breadth.reasons.join(", ")}`);
  }
  if (!option.isBaseline && programBreadth.mult < 1) {
    keyDrivers.push(`Program-breadth: ${programBreadth.reasons.join(", ")}`);
  }
  if (!option.isBaseline && (option.comparatorType === "active" || option.nullResponseRateOverride != null)) {
    keyDrivers.push("Active comparator → harder efficacy bar (lower P of trial success)");
  }
  if (priorShiftDriver) keyDrivers.push(priorShiftDriver);
  if (continuousDriver) keyDrivers.push(continuousDriver);
  if (regDriver) keyDrivers.push(regDriver);
  for (const d of marketDrivers) keyDrivers.push(`Market: ${d}`);
  if (option.designType && option.designType !== base.baseTrialDesign.designType) {
    const from = base.baseTrialDesign.designType.replace("_", " ");
    const to   = option.designType.replace("_", " ");
    keyDrivers.push(`Design: ${from} → ${to}`);
  }
  if (option.n && option.n !== base.baseTrialDesign.n) {
    keyDrivers.push(`n: ${base.baseTrialDesign.n} → ${option.n}`);
  }
  if (option.inclusionCriteria && option.inclusionCriteria !== "standard") {
    keyDrivers.push(`${option.inclusionCriteria} inclusion → market re-derived (pool/price/share)`);
  }
  if (option.ownershipPct != null) {
    keyDrivers.push(`${option.ownershipPct}% ownership (costs + revenue)`);
  }
  if (option.isOutlicensed) {
    keyDrivers.push(`Out-licensed → ${((option.royaltyPctOverride ?? base.avgRoyalty) * 100).toFixed(0)}% royalty`);
  }
  if (option.isVOI) {
    keyDrivers.push(`VOI: $${option.voiCostM ?? 0}M study + ${option.voiMonths ?? 0}mo delay`);
  }
  if (option.numArms === 3) {
    keyDrivers.push("3-arm design → cost ×1.4 vs 2-arm RCT");
  }

  const ptrsDrivers = Math.abs(ptrsDiff) > 0.005
    ? `P(approval) ${ptrsDiff >= 0 ? "+" : ""}${(ptrsDiff * 100).toFixed(1)}% vs Option A ` +
      `(${(baselinePtrs * 100).toFixed(1)}% → ${(ptrs * 100).toFixed(1)}%)`
    : `P(approval) ${(ptrs * 100).toFixed(1)}% (same as Option A)`;

  return {
    option,
    ptrs, ptrsCI,
    peakSalesM, devCostM, revenuePVM,
    eNPVM, eROI,
    deltaENPVM, deltaCostM, marginalEROI,
    eNPVLowM, eNPVHighM,
    voiENPVM, voiVsDirectM,
    durationMonths,
    keyDrivers, ptrsDrivers,
    nicheProvenance,
  };
}

// ─── Compute All Options ──────────────────────────────────────────────────────
// Call this to compute the full comparison. Options[0] should be the baseline.

export function computeAllOptions(
  base: BaseContext,
  options: OptionInputs[],
): OptionResult[] {
  const results: OptionResult[] = [];
  let optionA: OptionResult | undefined;

  for (const opt of options) {
    const result = computeOption(base, opt, optionA);
    results.push(result);
    if (opt.isBaseline || !optionA) optionA = result;
  }
  return results;
}

// ─── Build Base Context from Valuation ────────────────────────────────────────
// Call this in the UI to create the BaseContext from current page state.
// Returns null if the valuation doesn't have enough data yet.

export function buildBaseContext(
  v: Valuation,
  out: { ptrs: number; revenuePV: number; devCostPV: number; rnpv: number },
  ptrsResult: any,   // result from /api/ptrs-score
  layer2Result: any, // result from /api/ptrs-layer2
  effectPrior?: EffectPrior | null, // result from /api/effect-prior, if loaded
  devPlan?: DevPlanResult | null,   // result of computeDevPlan, if available
): BaseContext | null {
  // Need at least some financial data
  const peakSalesRaw = v.indications?.[0]?.peakSales ?? v.peakSales ?? 0;
  const devCostRaw   = v.indications?.[0]?.devCostPV ?? v.devCostPV ?? 0;

  if (!peakSalesRaw && !devCostRaw && !v.asset) return null;

  // Derive base trial design from Layer 2 if available, else phase-appropriate defaults.
  // NOTE: the /api/ptrs-layer2 endpoint returns the field as "trialInputs", not "inputs".
  const baseTrialDesign: TrialDesignInputs = layer2Result?.trialInputs ?? {
    n:                 estimateDefaultN(v.phase),
    endpointType:      "surrogate" as EndpointType,
    designType:        "single_arm" as DesignType,
    populationType:    "broad" as PopulationType,
    placeboResponse:   "low" as PlaceboResponse,
    regulatoryContext: "standard" as RegulatoryContext,
  };

  const ptrsLayer1 = ptrsResult?.ptrs ?? out.ptrs;
  const ciHalfWidthFromResult = ptrsResult?.ptrsCI
    ? (ptrsResult.ptrsCI.upper - ptrsResult.ptrsCI.lower) / 2
    : 0.10;

  const currentYear = new Date().getFullYear();

  const firstStage = devPlan?.stages?.[0];
  const resolverEconomics = firstStage
    ? {
        n:                      firstStage.n,
        cpp:                    firstStage.cpp,
        enrollmentRatePerMonth: firstStage.enrollmentRatePerMonth,
        treatmentObsMonths:     firstStage.treatmentObsMonths,
        startupCushionMonths:   firstStage.startupCushionMonths,
      }
    : undefined;

  const devPlanInputs = devPlan?.stages?.length
    ? {
        stages:             devPlan.stages as unknown as DevStageInput[],
        regulatoryContext:  devPlan.regStage.regulatoryContext,
        regCostM:           devPlan.regStage.costM,
        modalityClassStatus: devPlan.modalityClassStatus,
      }
    : null;

  return {
    mss:                ptrsResult?.mss ?? 0.5,
    variance:           ptrsResult?.variance ?? 0.3,
    ptrsLayer1,
    ciHalfWidth:        ciHalfWidthFromResult,
    effectPrior:        effectPrior ?? null,
    resolverEconomics,
    devPlanInputs,
    devPlanPApproval:     devPlan?.pApproval ?? null,
    devPlanRiskAdjCostM:  devPlan?.totalRiskAdjCostM ?? null,
    baseTrialDesign,
    // Base market (Build 1/1b): calibrate TAM+penetration so deriveMarket === base peak,
    // and carry the eligible-patient COUNT + annual WAC as separate components (Build 1b)
    // so a niche can be reasoned against real base anchors. eligiblePatients = tamM/price.
    market: (() => {
      const ind0 = v.indications?.[0];
      const cal = calibrateBaseMarket(peakSalesRaw / 1e6, { tamM: ind0?.tamM, penetrationPct: ind0?.penetrationPct });
      const annualPriceUsd = ind0?.annualPriceUsd && ind0.annualPriceUsd > 0 ? ind0.annualPriceUsd : undefined;
      const eligiblePatients = annualPriceUsd ? (cal.tamM * 1e6) / annualPriceUsd : undefined;
      return { ...cal, annualPriceUsd, eligiblePatients } as BaseMarket;
    })(),
    ptrs:         out.ptrs,
    peakSalesM:   peakSalesRaw / 1e6,
    // Prefer the dev-plan engine's risk-adjusted cost over the stale devCostPV
    // full-program default, so option costs reconcile with the headline.
    devCostM:     devPlan?.totalRiskAdjCostM ?? (devCostRaw / 1e6),
    launchYear:   v.indications?.[0]?.launchYear ?? v.launchYear ?? currentYear + 5,
    loeYear:      v.indications?.[0]?.loeYear    ?? v.loeYear    ?? currentYear + 15,
    discountRate:         v.discountRate         ?? 0.12,
    cogsPct:              v.cogsPct              ?? 0.20,
    taxRate:              v.taxRate              ?? 0.21,
    workingCapitalPct:    v.workingCapitalPct    ?? 0.10,
    avgRoyalty:           v.avgRoyalty           ?? 0.15,
    ownerType:            v.ownerType            ?? "Owner",
    phase:                v.phase                ?? "Phase 2",
  };
}

// ─── Early-Signal Resolver (bimodal VOI) ──────────────────────────────────────
// When the effect prior is "bimodal" (the evidence chain found a real conflict —
// e.g. mechanism looks great but the closest analog drug failed), the two
// possible "stories" imply very different odds of trial success. This option
// proposes a smaller preliminary study sized to resolve which story is true
// BEFORE committing to the full next stage. Returns null for unimodal priors
// or when there isn't a next dev-plan stage to scale the preliminary study from.

export function generateBimodalVoiOption(base: BaseContext): OptionInputs | null {
  if (base.effectPrior?.shape !== "bimodal" || !base.resolverEconomics) return null;

  const mixture = base.effectPrior.mixture;
  const [, strong] = [...mixture].sort((a, b) => a.mu - b.mu);

  const { sigma2Trial, threshold } = computeTrialNoise(base.baseTrialDesign);
  const pIfStrong = mixtureSuccessProbability([{ ...strong, w: 1 }], threshold, sigma2Trial);
  const pNow = mixtureSuccessProbability(mixture, threshold, sigma2Trial);
  const voiPtrsBoostIfPositive = Math.max(0, pIfStrong - pNow);

  const { n, cpp, enrollmentRatePerMonth, treatmentObsMonths, startupCushionMonths } = base.resolverEconomics;
  const nResolver = Math.max(10, Math.round(n * 0.35));
  const voiCostM = (nResolver * cpp) / 1e6;
  const voiMonths = Math.ceil(nResolver / Math.max(enrollmentRatePerMonth, 0.1) + treatmentObsMonths + startupCushionMonths);

  return {
    id: "voi-resolver",
    name: "Early-Signal Resolver",
    categories: ["voi"],
    isVOI: true,
    voiType: "biomarker_validation",
    voiCostM,
    voiMonths,
    voiProbPositive: strong.w,
    voiPtrsBoostIfPositive,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function round1(x: number)  { return Math.round(x * 10) / 10; }
function round2(x: number)  { return Math.round(x * 100) / 100; }

function estimateDefaultN(phase?: string): number {
  const defaults: Record<string, number> = {
    Preclinical: 10,
    "Phase 1":   20,
    "Phase 2":   50,
    "Phase 3":  200,
    Filed:      200,
    Approved:    50,
  };
  return defaults[phase ?? "Phase 2"] ?? 50;
}
