// ─── Scenario-driven market model (Build 1 of 3) ───────────────────────────────
//
// The bottom-up market reasoning already exists in pages/api/revenue-assumptions.ts
// (the LLM enforces: tamM = eligible patients × annual WAC; peakSalesM = tamM ×
// penetration). But it runs ONCE at auto-value for the base indication and is never
// re-invoked per scenario — so every scenario market change was a MULTIPLIER on the
// base peak (POPULATION_/INCLUSION_/DESIGN_PEAK_SALES_MULT, or an LLM peak override).
//
// This module exposes that SAME identity as a pure function and re-derives the market
// per scenario from its drivers (eligible population, price, penetration), so peak
// FALLS OUT of the reasoning instead of being haircut. A precision niche can win a
// HIGHER share and price on a SMALLER pool — the net is calculated, not assumed.
//
// PURE, no I/O. Revenue-side only — touches NO probability.

// tamM = drug-specific addressable market in $M (eligible patients × annual price).
// peakSalesM = tamM × penetration. This is the revenue-assumptions.ts identity.
export type MarketParams = { tamM: number; penetrationPct: number };

export type DerivedMarket = MarketParams & { peakSalesM: number };

const clampPct = (x: number) => Math.max(0, Math.min(100, x));

/** The identity, as a function: peak = TAM × penetration. */
export function deriveMarket(p: MarketParams): DerivedMarket {
  const tamM = Math.max(0, p.tamM);
  const penetrationPct = clampPct(p.penetrationPct);
  return { tamM, penetrationPct, peakSalesM: tamM * (penetrationPct / 100) };
}

/**
 * Calibrate the base indication's market parameters so deriveMarket reproduces the
 * peak the valuation actually USES (the comp-anchored base peak). We trust the LLM's
 * penetration % (a real, <100% share estimate that gives the niche room to grow) and
 * back out TAM to match the anchored peak: tamM = basePeak / penetration. When no
 * market context was captured, fall back to a neutral penetration so scenario drivers
 * still have somewhere to move. deriveMarket(base) === basePeakM by construction.
 */
export function calibrateBaseMarket(
  basePeakM: number,
  ctx?: { tamM?: number | null; penetrationPct?: number | null },
): MarketParams {
  const penetrationPct = clampPct(
    ctx?.penetrationPct != null && ctx.penetrationPct > 0 ? ctx.penetrationPct : DEFAULT_BASE_PENETRATION_PCT,
  );
  const tamM = penetrationPct > 0 ? basePeakM / (penetrationPct / 100) : basePeakM;
  return { tamM, penetrationPct };
}

// Neutral base penetration when revenue-assumptions didn't return one (a broad-label
// drug in a competed market — leaves headroom for a niche to out-penetrate it).
const DEFAULT_BASE_PENETRATION_PCT = 25;

// The base indication's market COMPONENTS (Build 1b) — eligible-patient count and
// annual WAC persisted SEPARATELY, not just their product tamM. The niche is reasoned
// against these real anchors; the decoupling guard holds them fixed.
export type BaseMarket = MarketParams & {
  eligiblePatients?: number;  // base indication eligible-patient count
  annualPriceUsd?: number;    // base annual WAC ($/patient/yr)
};

// ─── Genuinely bottom-up niche market (Build 1b) ────────────────────────────────
// A re-derived niche is computed from the niche's OWN ABSOLUTE parameters — an eligible
// patient COUNT, an annual WAC ($), and a peak SHARE % — each reasoned from niche
// characteristics and real comparators. NONE of these is a factor on the base peak /
// base tam / base penetration (that was the Build-1 disguised multiplier:
// basePeak × prevalence × pricePremium × penetrationMult). The niche peak is therefore
// INDEPENDENT of the base peak when the niche's own parameters are held fixed — that
// invariance is the load-bearing guard that the re-derivation is genuine.
export type NicheParams = {
  nicheEligiblePatients: number;  // absolute count (= indication eligible pop × biomarker prevalence)
  nicheAnnualPriceUsd: number;    // absolute WAC $/yr, reasoned from precision-therapy comparators
  nichePeakSharePct: number;      // absolute peak share %, reasoned from niche competitive dynamics
};

// ABSOLUTE grounded defaults (labeled $ / % values, NOT base-relative factors). Used only
// when the LLM cannot source an asset-specific figure; each is shown as a default in the
// provenance so it's visible as an assumption.
export const NICHE_PRICE_DEFAULT_USD = 200_000;      // typical precision-therapy WAC/yr
export const NICHE_SHARE_DEFAULT_PCT = 35;           // differentiated defined-responder peak share
export const BIOMARKER_PREVALENCE_DEFAULT = 0.35;    // enriched-eligible fraction when unsourced

// HEURISTIC, PRE-CALIBRATION plausibility bands for a CITED niche WAC / peak share — hand-set
// (like Option B's magnitude bands), NOT empirical. A cited value that lands outside its band is
// clamped + flagged: the comps array carries {drug, peakSalesM} only (no per-comp WAC), so a
// cited price rides entirely on the LLM's number with nothing structured to check it against
// except this band — "cite any comp, then state any number" is the hole this closes. When a
// calibration record of observed targeted-launch WAC/share distributions exists, REPLACE these
// with empirical percentiles. Do NOT enshrine as truth.
export const NICHE_WAC_BAND_USD = { min: 150_000, max: 300_000 };  // heuristic, pre-calibration
export const NICHE_SHARE_BAND_PCT = { min: 20, max: 50 };          // heuristic, pre-calibration

// ─── Containment bound on the niche eligible COUNT (resolve-or-flag) ────────────
// WAC and peak share each go through resolveNicheParam (band + citation + clamp + flag). The eligible
// COUNT went through NOTHING: an LLM-supplied absolute short-circuited the base-relative path, so a
// "35% enriched subset" could assert MORE patients than the broad population it is carved from (observed
// live: 55,000 cited against a ~43,650 base pool → a 3.6× overstatement that flowed straight into TAM,
// peak, and eNPV). A subset cannot exceed its superset; this makes that an enforced INPUT invariant.
//
// The bound is the enriched FRACTION of the base pool (superset × prevalence) — not merely the superset,
// which would still admit ~2.9× of the observed error. The base-relative product is exactly the value the
// fallback path already computed, so the correct derivation becomes the authority and a cited absolute is
// treated as a CLAIM that must agree with it. Never silently trusted: no base pool → allowed + flagged.
export type NicheEligibleResolution = {
  value: number | null;         // the count actually USED (null → none derivable; caller holds at base)
  cited: number | null;         // the asserted absolute, if any
  supersetEligible: number | null;
  prevalence: number;
  bound: number | null;         // supersetEligible × prevalence
  derived: boolean;             // count came from the base-relative path (bounded by construction)
  clamped: boolean;             // cited exceeded the bound → clamped down to it
  exceededSuperset: boolean;    // cited exceeded the WHOLE base pool (structurally impossible)
  unbounded: boolean;           // cited accepted with no base pool to contain it against
};

export function resolveNicheEligible(p: {
  cited?: number | null;
  supersetEligible?: number | null;
  prevalence: number;
}): NicheEligibleResolution {
  const prevalence = p.prevalence;
  const superset = p.supersetEligible != null && p.supersetEligible > 0 ? p.supersetEligible : null;
  const bound = superset != null ? superset * prevalence : null;
  const cited = p.cited != null && p.cited > 0 ? p.cited : null;
  const nil = { cited, supersetEligible: superset, prevalence, bound, derived: false, clamped: false, exceededSuperset: false, unbounded: false };

  // No cited absolute → derive from the base pool (the correct path; contained by construction).
  if (cited == null) return { ...nil, value: bound, derived: true };
  // Cited, but no base pool to contain it against → use it, and FLAG (never silently trusted).
  if (bound == null) return { ...nil, value: cited, unbounded: true };
  // Cited within the enriched fraction → trust it (a smaller niche is the conservative direction).
  if (cited <= bound) return { ...nil, value: cited };
  // Cited exceeds the enriched fraction → clamp to the bound + flag; escalate when it exceeds the whole
  // pool (a genuine subset ⊄ superset violation; prevalence > 1 is a documented deliberate broadening).
  return { ...nil, value: bound, clamped: true, exceededSuperset: prevalence <= 1 && cited > superset! };
}

/**
 * Re-derive a niche market bottom-up from its OWN absolute parameters:
 *   nicheTamM   = nicheEligiblePatients × nicheAnnualPriceUsd / 1e6   (eligible × price)
 *   peakSalesM  = nicheTamM × nichePeakSharePct / 100                 (TAM × share)
 * No base peak / base tam / base penetration enters — so the result is INDEPENDENT of the
 * base peak (the decoupling property). The net can land above or below the base; it is
 * computed, not signed. Returns the derived market + an audit string of the absolutes used.
 */
export function deriveEnrichedNiche(p: NicheParams): DerivedMarket & { provenance: string } {
  const eligible = Math.max(0, p.nicheEligiblePatients);
  const price = Math.max(0, p.nicheAnnualPriceUsd);
  const sharePct = clampPct(p.nichePeakSharePct);
  const tamM = (eligible * price) / 1e6;
  const peakSalesM = tamM * (sharePct / 100);
  return {
    tamM,
    penetrationPct: sharePct,
    peakSalesM,
    provenance:
      `re-derived niche (bottom-up): ${Math.round(eligible).toLocaleString()} eligible × $${Math.round(price).toLocaleString()}/yr WAC ` +
      `→ TAM $${tamM.toFixed(0)}M × ${sharePct.toFixed(0)}% share → peak $${peakSalesM.toFixed(0)}M`,
  };
}

/**
 * Falsifiable identity check (the guard that CAN fail): confirms a derived niche satisfies
 * tamM === eligible × price AND peak === tamM × share for the given absolute params. A
 * tampered/internally-inconsistent result (e.g. a peak that isn't tamM × share) returns false.
 */
export function nicheIdentityHolds(m: DerivedMarket, p: NicheParams, tol = 1e-6): boolean {
  const expectedTamM = (Math.max(0, p.nicheEligiblePatients) * Math.max(0, p.nicheAnnualPriceUsd)) / 1e6;
  const expectedPeakM = expectedTamM * (clampPct(p.nichePeakSharePct) / 100);
  return Math.abs(m.tamM - expectedTamM) <= tol && Math.abs(m.peakSalesM - expectedPeakM) <= tol;
}
