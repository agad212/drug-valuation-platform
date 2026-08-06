// ─── LOE resolution (patents × FDA exclusivity × public statements) ────────────
//
// PURE, no I/O. Replaces the old computeLoeYear behaviour, which was near-circular: it used a patent
// expiry ONLY when `loeBasis === "patent"` was already set on state — which effectively only happened if a
// human clicked "Use ####" in the LOE panel. By default the panel was advisory and never reached revenue,
// so every asset silently fell to a launch-anchored exclusivity term.
//
// DIVISION OF LABOUR (no-leak, §1.4): the LLM emits STRUCTURED, CITED OBSERVABLES — patent types and
// expiries, whether each is in force at approval and covers the valued indication, designation flags,
// public LOE statements. This module computes every DATE deterministically. An LLM never emits an LOE year
// that reaches revenue.
//
// Every clock below runs from APPROVAL, so this must be resolved DOWNSTREAM of the dev plan's implied
// launch/approval year — not at auto-value time.
//
// ── US regulatory exclusivity (statutory; pinned, not estimated) ──────────────────────────────────────
// VERIFIED against FDA "Frequently Asked Questions on Patents and Exclusivity" and 21 USC 360cc (2026-08-06):
//   NCE (new chemical entity)      5 yr from approval           — whole drug (4 yr if a Para-IV filing lands)
//   ODE (orphan drug exclusivity)  7 yr from approval           — SCOPE IS NARROW, see below
//   "3-year" (new clinical inv.)   3 yr                         — the NEW INDICATION/change only
//   BPCIA (biologic)              12 yr from first licensure    — reference product; NOT extended by new indications
//   Pediatric (BPCA)              +6 months                     — added to ALL existing PATENTS **and** exclusivity
//                                                                 for that active moiety, so it extends BOTH the
//                                                                 exclusivity floor AND the patent ceiling
//   QIDP / GAIN                   +5 yr                         — on top of NCE/ODE/3-yr (anti-infectives)
//
// A SECOND INDICATION DOES NOT EXTEND THE FIRST. 21 USC 360cc(a) bars approval of "the same drug for the
// same approved use or indication within such rare disease or condition" — narrower even than per-disease:
// it is per approved USE. The 3-year term is likewise limited to the new conditions of approval, and
// BPCIA's 12 years is not extended by new indications at all. Hence exclusivity resolves PER INDICATION,
// and a portfolio's protection is governed by each indication's own clock.
//
// ── Patents: what actually protects revenue ──────────────────────────────────────────────────────────
//   compound / composition-of-matter — STRONG. Blocks the molecule irrespective of indication.
//   formulation                     — MEDIUM. Designable-around unless it is the only commercial form.
//   method-of-use                   — WEAK IN PRACTICE, BUT NOT TOOTHLESS. A generic carves the patented
//                                     indication out of its label (§viii "skinny label") and launches for the
//                                     remaining uses, so a 2041 MOU patent is NOT protection to 2041.
//                                     HOWEVER (verified 2026-08-06): the Federal Circuit's GSK v. Teva
//                                     holding STANDS — the Supreme Court DENIED certiorari on 2023-05-15
//                                     (Teva Pharms. USA v. GlaxoSmithKline, No. 22-37; Kavanaugh, J., would
//                                     have granted; the SG filed after a CVSG). So a skinny-label generic CAN
//                                     be liable for induced infringement where its own conduct/marketing
//                                     encourages the carved-out use. Net: the carve-out means an MOU patent
//                                     rarely BLOCKS entry outright, while inducement exposure gives it real
//                                     but CONDUCT-DEPENDENT settlement/delay leverage. Fact-dependent and
//                                     bimodal — exactly why this must be a PROBABILITY, never a constant.
//   PTE (35 USC §156): up to 5 yr for review time, capped at 14 yr of effective life post-approval, ONE
//   patent only, and the patent MUST still be in force at approval. (PTA §154(b) is a separate PTO-delay
//   restoration and is assumed already baked into a cited expiry.)
//
// UNCERTAINTY BECOMES CASES, NOT A POINT: a patent that is p-likely to hold produces a p-weighted patent
// case and a (1−p)-weighted exclusivity-floor case, so revenue can be run over both instead of asserting
// one date. Resolve-or-flag (§1.5) throughout: every clamp, default and divergence is surfaced.

export type PatentType = "compound" | "formulation" | "method-of-use" | "other";

export type PatentInput = {
  id: string;                       // e.g. "US9000023"
  type: PatentType;
  expiryYear: number;               // cited expiry (PTA assumed included)
  coversValuedIndication?: boolean; // false → cannot protect THIS indication's revenue
  pProtective?: number;             // 0–1, cited override of the type default (requires a rationale)
  pProtectiveRationale?: string;    // required for an override to be trusted (resolve-or-flag)
  pteEligible?: boolean;            // claimed §156 eligibility (still gated on in-force-at-approval below)
};

export type ExclusivityInput = {
  isBiologic?: boolean;
  isNCE?: boolean;                  // new chemical entity (small molecule, first approval of the moiety)
  orphanConfirmedForIndication?: boolean; // ODE — for THE INDICATION BEING VALUED
  newClinicalInvestigation?: boolean;     // the "3-year" term (a new indication of an approved moiety)
  pediatricExclusivity?: boolean;   // BPCA +6 months
  qidp?: boolean;                   // QIDP/GAIN +5 yr
};

export type PublicLoeStatement = {
  statedYear: number;
  source: string;                   // named source — an uncited statement is not trusted
  quote?: string;
};

export type LoeCase = {
  loeYear: number;
  weight: number;                   // 0–1, sums to 1 across cases
  basis: "patent" | "exclusivity" | "public-statement";
  rationale: string;
};

export type LoeResolution = {
  expectedLoeYear: number;          // weight-averaged, rounded — the single displayable number
  cases: LoeCase[];                 // the distribution revenue should be run over
  exclusivityFloorYear: number;     // statutory floor (approval + the longest applicable term)
  exclusivityTerm: string;          // which term set the floor
  patentCeilingYear: number | null; // best protective patent covering this indication, PTE applied
  flags: string[];
  provenance: string;
};

// ── Statutory terms (years from approval). Pinned law, not estimates. ──
export const TERM_NCE = 5;
export const TERM_ODE = 7;
export const TERM_NEW_CLINICAL_INVESTIGATION = 3;
export const TERM_BPCIA = 12;
export const TERM_PEDIATRIC = 0.5;
export const TERM_QIDP = 5;

// ── PTE bounds (35 USC §156) ──
export const PTE_MAX_YEARS = 5;
export const PTE_EFFECTIVE_LIFE_CAP_YEARS = 14;

// HEURISTIC, PRE-CALIBRATION probability that a patent of each type actually protects revenue through its
// expiry. Hand-set from the litigation/skinny-label pattern described above, NOT empirical — replace with
// observed generic-entry-vs-patent-expiry distributions at calibration. A cited override must carry a
// rationale, else the default holds + flags.
export const P_PROTECTIVE_DEFAULT: Record<PatentType, number> = {
  compound: 0.90,
  formulation: 0.55,
  "method-of-use": 0.30,
  other: 0.40,
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Statutory exclusivity floor: approval + the LONGEST applicable term, indication-scoped. */
function resolveExclusivityFloor(approvalYear: number, ex: ExclusivityInput): { year: number; term: string; flags: string[] } {
  const flags: string[] = [];
  const candidates: { years: number; label: string }[] = [];
  if (ex.isBiologic) candidates.push({ years: TERM_BPCIA, label: "BPCIA 12-yr biologic" });
  if (ex.orphanConfirmedForIndication) candidates.push({ years: TERM_ODE, label: "orphan (ODE) 7-yr" });
  if (ex.isNCE && !ex.isBiologic) candidates.push({ years: TERM_NCE, label: "NCE 5-yr" });
  if (ex.newClinicalInvestigation) candidates.push({ years: TERM_NEW_CLINICAL_INVESTIGATION, label: "new-clinical-investigation 3-yr" });

  if (candidates.length === 0) {
    // No exclusivity basis emitted. Hold at the small-molecule NCE term as a LABELED default rather than
    // assuming zero protection, and flag it — never a silent assumption either way.
    candidates.push({ years: TERM_NCE, label: "NCE 5-yr (ASSUMED — no exclusivity basis emitted)" });
    flags.push("exclusivity basis not emitted → held at the labeled NCE 5-yr default");
  }

  let best = candidates.reduce((a, b) => (b.years > a.years ? b : a));
  let years = best.years;
  const parts = [best.label];
  // Add-ons stack on top of the governing term.
  if (ex.qidp) { years += TERM_QIDP; parts.push(`QIDP +${TERM_QIDP}yr`); }
  if (ex.pediatricExclusivity) { years += TERM_PEDIATRIC; parts.push("pediatric +6mo"); }

  return { year: Math.round(approvalYear + years), term: parts.join(" + "), flags };
}

/**
 * Best protective patent for THIS indication, with PTE applied under §156.
 * A patent that has already EXPIRED at approval cannot protect the product and cannot receive PTE —
 * the single most consequential rule here (a pre-approval compound-patent expiry is commercially moot).
 */
function resolvePatentCeiling(approvalYear: number, patents: PatentInput[], pediatric = false): {
  year: number | null; patent: PatentInput | null; p: number; flags: string[]; note: string;
} {
  const flags: string[] = [];
  const eligible: { p: PatentInput; effective: number; pProt: number }[] = [];

  for (const p of patents) {
    if (p.coversValuedIndication === false) {
      flags.push(`${p.id} (${p.type}) excluded — does not cover the valued indication`);
      continue;
    }
    const inForceAtApproval = p.expiryYear > approvalYear;
    if (!inForceAtApproval) {
      flags.push(`${p.id} (${p.type}) expires ${p.expiryYear} BEFORE approval ${approvalYear} → cannot protect revenue and is PTE-ineligible`);
      continue;
    }
    let effective = p.expiryYear;
    if (p.pteEligible) {
      // §156: +5 yr max, and total effective life post-approval capped at 14 yr.
      const withPte = p.expiryYear + PTE_MAX_YEARS;
      const cap = approvalYear + PTE_EFFECTIVE_LIFE_CAP_YEARS;
      effective = Math.min(withPte, cap);
      if (withPte > cap) flags.push(`${p.id} PTE clipped by the §156 14-yr effective-life cap (${cap})`);
    }
    // Pediatric exclusivity (BPCA) is added to ALL existing PATENTS as well as exclusivity for the active
    // moiety — per FDA: "a 6-month period of exclusivity is added to all existing patents and exclusivity on
    // all applications held by the sponsor for that active moiety." It therefore rides on top of PTE too.
    if (pediatric) effective = Math.round(effective + TERM_PEDIATRIC);
    // Probability this patent actually holds: a cited override needs a rationale, else the type default.
    let pProt = P_PROTECTIVE_DEFAULT[p.type];
    if (p.pProtective != null) {
      if (p.pProtectiveRationale && p.pProtectiveRationale.trim().length > 0) {
        pProt = clamp01(p.pProtective);
      } else {
        flags.push(`${p.id} pProtective ${p.pProtective} UNSOURCED (no rationale) → held at the ${p.type} default ${P_PROTECTIVE_DEFAULT[p.type]}`);
      }
    }
    eligible.push({ p, effective, pProt });
  }

  if (eligible.length === 0) return { year: null, patent: null, p: 0, flags, note: "no patent protects the valued indication past approval" };

  // The governing patent is the one giving the LATEST protected year; ties break toward the stronger type.
  const best = eligible.reduce((a, b) => (b.effective > a.effective ? b : (b.effective === a.effective && b.pProt > a.pProt ? b : a)));
  if (best.p.type === "method-of-use") {
    flags.push(`governing patent ${best.p.id} is METHOD-OF-USE — a generic can carve the indication out via a §viii skinny label, so this date is materially uncertain (p=${best.pProt})`);
  }
  return {
    year: best.effective, patent: best.p, p: best.pProt, flags,
    note: `${best.p.id} (${best.p.type}) → ${best.effective}${best.p.pteEligible ? " incl. PTE" : ""}, p(protective)=${best.pProt}`,
  };
}

/**
 * Resolve LOE for ONE indication as a weighted case distribution.
 *
 * Order of authority:
 *   1. A SOURCED public LOE statement anchors — but is floored at the statutory exclusivity minimum (a
 *      third party cannot state away a statutory term) and flagged when it diverges from the computed view.
 *      Analyst LOE statements are frequently stale, so the divergence is surfaced rather than hidden.
 *   2. Otherwise: the patent ceiling and the exclusivity floor become WEIGHTED CASES —
 *      p(patent holds) → max(patentCeiling, floor); (1−p) → the floor.
 *   3. With no protective patent, the floor is the single case.
 */
export function resolveLoe(input: {
  approvalYear: number;
  exclusivity: ExclusivityInput;
  patents?: PatentInput[];
  publicStatements?: PublicLoeStatement[];
}): LoeResolution {
  const { approvalYear, exclusivity } = input;
  const patents = input.patents ?? [];
  const flags: string[] = [];

  const floor = resolveExclusivityFloor(approvalYear, exclusivity);
  flags.push(...floor.flags);
  const ceiling = resolvePatentCeiling(approvalYear, patents, exclusivity.pediatricExclusivity === true);
  flags.push(...ceiling.flags);

  const sourced = (input.publicStatements ?? []).filter((s) => s.source?.trim() && Number.isFinite(s.statedYear));
  let cases: LoeCase[];
  let provenance: string;

  if (sourced.length > 0) {
    // Most conservative sourced statement wins among several (do not cherry-pick the most favourable).
    const stmt = sourced.reduce((a, b) => (b.statedYear < a.statedYear ? b : a));
    const floored = Math.max(stmt.statedYear, floor.year);
    if (floored > stmt.statedYear) {
      flags.push(`public LOE ${stmt.statedYear} (${stmt.source}) is BELOW the statutory exclusivity floor ${floor.year} (${floor.term}) → raised to the floor`);
    }
    const computedView = Math.max(floor.year, ceiling.year ?? floor.year);
    if (Math.abs(floored - computedView) >= 3) {
      flags.push(`public LOE ${floored} diverges ≥3yr from the patent/exclusivity view ${computedView} — the statement may be stale or scope-limited`);
    }
    cases = [{ loeYear: floored, weight: 1, basis: "public-statement", rationale: `sourced public LOE: ${stmt.source}${stmt.quote ? ` — "${stmt.quote}"` : ""}` }];
    provenance = `public statement (${stmt.source}) → ${floored}; floor ${floor.year} (${floor.term}); patent view ${ceiling.year ?? "none"}`;
  } else if (ceiling.year != null && ceiling.year > floor.year) {
    const p = ceiling.p;
    const weighted: LoeCase[] = [
      { loeYear: ceiling.year, weight: p, basis: "patent", rationale: `patent holds: ${ceiling.note}` },
      { loeYear: floor.year, weight: 1 - p, basis: "exclusivity", rationale: `patent does not hold → statutory floor ${floor.term}` },
    ];
    cases = weighted.filter((c) => c.weight > 0);
    provenance = `weighted: ${(p * 100).toFixed(0)}% patent ${ceiling.year} / ${((1 - p) * 100).toFixed(0)}% exclusivity ${floor.year} (${floor.term})`;
  } else {
    const why = ceiling.year == null ? ceiling.note : `patent ${ceiling.year} does not extend past the ${floor.term} floor`;
    cases = [{ loeYear: floor.year, weight: 1, basis: "exclusivity", rationale: `${floor.term} from approval ${approvalYear} — ${why}` }];
    provenance = `exclusivity-governed: ${floor.year} (${floor.term}); ${why}`;
  }

  const expectedLoeYear = Math.round(cases.reduce((s, c) => s + c.weight * c.loeYear, 0));
  return {
    expectedLoeYear,
    cases,
    exclusivityFloorYear: floor.year,
    exclusivityTerm: floor.term,
    patentCeilingYear: ceiling.year,
    flags,
    provenance,
  };
}
