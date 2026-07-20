// ─── Financial-input pins (Fix #2) ─────────────────────────────────────────────
//
// PURE, no I/O. Anchors the three un-pinned dollar inputs that still swing run-to-
// run — cost-per-patient, peak sales, and LOE — to real benchmarks / the comps the
// pipeline already retrieves / transparent rules. Called by BOTH the deterministic
// layer (lib/dev-plan.ts computeDevPlan, the offline harness) and the live path
// (pages/index.tsx), never regenerated per-run by an LLM. Same discipline as the
// comparator/endpoint/timeline pins: pin to sources, bound by code, label
// provenance — NEVER tune to a desired eNPV. Touches NO probability value.

import type { RegulatoryContext, PopulationType } from "./ptrs-trial";

// ── Part A: cost-per-patient benchmarks (phase × therapeutic area) ──────────────
// Central + credible band, in USD. Sourced from published per-patient clinical-
// trial cost studies: Sertkaya et al. (HHS/ASPE, "Costs of Drug Development"),
// Moore et al. (JAMA Intern Med 2018, per-trial/per-patient by phase), Tufts CSDD.
// These ARE the ranges already stated in the /api/dev-plan CPP_REFERENCE prompt —
// codified here so the value is deterministic instead of a per-run LLM guess.

export type TherapeuticArea =
  | "oncology" | "rare_orphan" | "ophthalmology" | "cns"
  | "cardiometabolic" | "immunology" | "infectious" | "general";

type PhaseBucket = "phase1" | "phase2" | "phase3";
type Band = { central: number; min: number; max: number };

const CPP_BENCHMARKS: Record<TherapeuticArea, Record<PhaseBucket, Band>> = {
  oncology:        { phase1: { central: 80_000,  min: 60_000,  max: 100_000 }, phase2: { central: 140_000, min: 100_000, max: 180_000 }, phase3: { central: 215_000, min: 150_000, max: 280_000 } },
  rare_orphan:     { phase1: { central: 110_000, min: 80_000,  max: 140_000 }, phase2: { central: 215_000, min: 150_000, max: 280_000 }, phase3: { central: 350_000, min: 250_000, max: 450_000 } },
  ophthalmology:   { phase1: { central: 110_000, min: 80_000,  max: 140_000 }, phase2: { central: 240_000, min: 180_000, max: 300_000 }, phase3: { central: 335_000, min: 250_000, max: 420_000 } },
  // CNS not in the original table; long follow-up + imaging-heavy endpoints put it
  // near oncology (CPP_REFERENCE "+imaging (+20–40%)" / "+long follow-up" adjustments).
  cns:             { phase1: { central: 70_000,  min: 50_000,  max: 95_000 },  phase2: { central: 150_000, min: 110_000, max: 190_000 }, phase3: { central: 220_000, min: 170_000, max: 280_000 } },
  cardiometabolic: { phase1: { central: 55_000,  min: 40_000,  max: 70_000 },  phase2: { central: 80_000,  min: 60_000,  max: 100_000 }, phase3: { central: 110_000, min: 80_000,  max: 140_000 } },
  immunology:      { phase1: { central: 55_000,  min: 40_000,  max: 70_000 },  phase2: { central: 90_000,  min: 65_000,  max: 115_000 }, phase3: { central: 120_000, min: 90_000,  max: 150_000 } },
  infectious:      { phase1: { central: 50_000,  min: 35_000,  max: 65_000 },  phase2: { central: 75_000,  min: 55_000,  max: 95_000 },  phase3: { central: 105_000, min: 75_000,  max: 135_000 } },
  general:         { phase1: { central: 55_000,  min: 40_000,  max: 70_000 },  phase2: { central: 80_000,  min: 60_000,  max: 100_000 }, phase3: { central: 110_000, min: 80_000,  max: 140_000 } },
};

const CPP_SOURCE = "Sertkaya/ASPE + Moore (JAMA Intern Med 2018) per-patient trial-cost benchmarks by phase & therapeutic area";

function phaseBucket(phase: string): PhaseBucket {
  if (/3|registration|pivotal/i.test(phase)) return "phase3";
  if (/2/.test(phase)) return "phase2";
  if (/1/.test(phase)) return "phase1";
  return "phase2";
}

export function inferTherapeuticArea(indication?: string): TherapeuticArea {
  const s = (indication || "").toLowerCase();
  if (/(alzheimer|parkinson|dementia|\bcns\b|neuro|epilep|multiple sclerosis|huntington|\bals\b|migraine|schizophren|\btau\b|cognit)/.test(s)) return "cns";
  if (/(retina|ophthalm|macular|glaucoma|uveitis|geographic atrophy|bcva)/.test(s)) return "ophthalmology";
  if (/(cancer|carcinoma|tumou?r|oncolog|leukemi|lymphoma|myeloma|melanoma|sarcoma|glioma|glioblast|\bmrd\b|metasta|nsclc|\bcrc\b|colorectal|breast|prostate|pancrea|ovarian|gastric)/.test(s)) return "oncology";
  if (/(cardio|heart|athero|cholesterol|diabet|obesity|metabolic|\bnash\b|hypertens|dyslipid)/.test(s)) return "cardiometabolic";
  if (/(lupus|rheumat|psoria|crohn|colitis|autoimmun|immunolog|asthma|atopic|dermatitis)/.test(s)) return "immunology";
  if (/(infect|viral|bacteri|\bhiv\b|hepatitis|sepsis|influenza|vaccine|antibiotic)/.test(s)) return "infectious";
  if (/(rare|orphan|duchenne|cystic fibrosis|hemophilia|gaucher|pompe|\bsma\b)/.test(s)) return "rare_orphan";
  return "general";
}

export type CppPin = { cpp: number; raw?: number; clamped: boolean; provenance: string; source: string };

/**
 * Pin cost-per-patient to the phase × therapeutic-area benchmark central value
 * (deterministic — the pinned value GOVERNS so identical assets stop swinging).
 * A rare/orphan designation or a rare/small population uses the rare-disease band
 * (already premium-loaded). The LLM's suggestion is recorded and flagged when it
 * falls outside the credible band, but does not drive the math.
 */
export function pinCostPerPatient(
  phase: string,
  therapeuticArea: TherapeuticArea = "general",
  opts?: { populationType?: PopulationType; regulatoryContext?: RegulatoryContext; llmCpp?: number },
): CppPin {
  const bucket = phaseBucket(phase);
  const rareByDesignation = opts?.regulatoryContext === "orphan" || opts?.regulatoryContext === "btd_orphan";
  const rareByPopulation = opts?.populationType === "rare_small";
  const effectiveTA: TherapeuticArea = (rareByDesignation || rareByPopulation) ? "rare_orphan" : therapeuticArea;
  const band = (CPP_BENCHMARKS[effectiveTA] ?? CPP_BENCHMARKS.general)[bucket];
  const llm = opts?.llmCpp;
  const outOfBand = llm != null && llm > 0 && (llm < band.min || llm > band.max);
  const taNote = effectiveTA !== therapeuticArea ? `${effectiveTA} (rare/specialized premium)` : effectiveTA;
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  return {
    cpp: band.central,
    raw: llm,
    clamped: !!outOfBand,
    provenance: `pinned: ${taNote} ${bucket} ${k(band.central)}` +
      (outOfBand ? ` (LLM ${k(llm!)} outside ${k(band.min)}–${k(band.max)} band)` : ""),
    source: CPP_SOURCE,
  };
}

// ── Part B: peak-sales anchoring to retrieved comparables ───────────────────────

export type PeakComp = { drug: string; peakSalesM: number; relation?: "anchor" | "ceiling" | "context" };
export type PeakPin = { baseM: number; bullM: number; bearM: number; provenance: string; anchors: string[] };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Anchor base-case peak sales to the closest structural comparables the pipeline
 * already surfaced (median of the "anchor" comps), with a ceiling comp bounding the
 * bull case. Deterministic given the comp set — no free per-run LLM estimate. Falls
 * back to a labeled unanchored estimate only when no usable comps exist.
 */
export function anchorPeakSales(comps: PeakComp[] | undefined, opts?: { rawLlmPeakM?: number }): PeakPin {
  const usable = (comps ?? []).filter((c) => c.peakSalesM > 0);
  const anchors = usable.filter((c) => c.relation !== "ceiling");
  const ceilings = usable.filter((c) => c.relation === "ceiling");

  if (anchors.length === 0) {
    const base = Math.round(opts?.rawLlmPeakM ?? 0);
    return {
      baseM: base, bullM: Math.round(base * 1.6), bearM: Math.round(base * 0.5),
      provenance: `estimate: no structural comps retrieved — LLM peak $${base}M (unanchored, wide range)`,
      anchors: [],
    };
  }

  const vals = anchors.map((c) => c.peakSalesM);
  const baseM = Math.round(median(vals));
  const ceilingVal = ceilings.length ? Math.max(...ceilings.map((c) => c.peakSalesM)) : Math.max(...vals) * 1.5;
  const bullM = Math.round(Math.min(ceilingVal, Math.max(...vals) * 1.5));
  const bearM = Math.round(Math.min(...vals) * 0.7);
  const names = anchors.map((c) => `${c.drug} $${Math.round(c.peakSalesM)}M`);
  const ceilNote = ceilings.length ? `ceiling ${ceilings[0].drug} $${Math.round(ceilingVal)}M bounds bull` : "top comp ×1.5 bounds bull";
  return {
    baseM, bullM, bearM,
    provenance: `pinned: base = median of comps [${names.join(", ")}]; ${ceilNote}`,
    anchors: names,
  };
}

/**
 * Tag retrieved comps as "anchor" vs "ceiling": a comp whose peak is a gross
 * outlier (> 5× the median of the set) is a market-ceiling reference (e.g. a
 * blockbuster), not a structural anchor. Shared by the live path and the capture
 * script so the anchoring is identical everywhere.
 */
export function classifyComps(comps: { drug: string; peakSalesM: number }[]): PeakComp[] {
  const vals = comps.filter((c) => c.peakSalesM > 0).map((c) => c.peakSalesM);
  if (vals.length <= 2) return comps.map((c) => ({ drug: c.drug, peakSalesM: c.peakSalesM, relation: "anchor" }));
  const med = median(vals);
  return comps.map((c) => ({
    drug: c.drug, peakSalesM: c.peakSalesM,
    relation: c.peakSalesM > 5 * med ? "ceiling" : "anchor",
  }));
}

// ── Part C: LOE / exclusivity year (real data or labeled rule) ──────────────────

export type Modality = "biologic" | "small_molecule" | "oligonucleotide" | "cell_gene" | "other";
export type LoePin = {
  loeYear: number; basis: "patent" | "exclusivity"; exclusivityYears: number;
  provenance: string; isEstimate: boolean;
};

export function inferModality(mechanism?: string): Modality {
  const s = (mechanism || "").toLowerCase();
  if (/(car-?t|cell therapy|gene therapy|\baav\b|crispr|lentivir)/.test(s)) return "cell_gene";
  if (/(antisense|oligonucleotide|\baso\b|sirna|\bmirna\b|micro-?rna|\bmir-?\d|locked nucleic)/.test(s)) return "oligonucleotide";
  if (/(antibody|\bmab\b|monoclonal|\bigg\b|fusion protein|biologic|recombinant|peptide)/.test(s)) return "biologic";
  if (/(small molecule|inhibitor|antagonist|agonist|degrader|\bproTAC\b|kinase)/.test(s)) return "small_molecule";
  return "other";
}

/**
 * LOE year: real patent/exclusivity expiry when available, else a TRANSPARENT
 * rule-based estimate (launch + the binding regulatory-exclusivity term), always
 * LABELED as an estimate. Never fabricates a patent date. Biologics/cell-gene get
 * BPCIA 12y; small-molecule/oligo NCE 5y; orphan adds a 7y floor — the binding
 * (max) term applies. Shifts with launch year by construction.
 */
export function computeLoeYear(opts: {
  launchYear: number; modality: Modality;
  regulatoryContext?: RegulatoryContext; patentLoeYear?: number | null;
  orphanConfirmed?: boolean;
}): LoePin {
  const { launchYear, modality, regulatoryContext, patentLoeYear, orphanConfirmed } = opts;
  const isOrphan = regulatoryContext === "orphan" || regulatoryContext === "btd_orphan";
  const biologic = modality === "biologic" || modality === "cell_gene";

  // Binding regulatory exclusivity term (the statutory floor for the commercial window).
  const terms: { term: number; label: string }[] = [
    biologic ? { term: 12, label: "BPCIA 12y biologic exclusivity" } : { term: 5, label: "NCE 5y small-molecule/oligo exclusivity" },
  ];
  // Orphan 7y only when the designation is CONFIRMED for the base-case indication
  // (honors Fix B — an unearned cross-indication orphan does not extend the window).
  if (isOrphan && orphanConfirmed) terms.push({ term: 7, label: "orphan 7y exclusivity" });
  const binding = terms.reduce((a, b) => (b.term > a.term ? b : a));

  // LOE = the LATER of (a) a real patent/exclusivity date after launch and (b) the
  // regulatory floor (launch + binding term). HARD INVARIANT: LOE is anchored to
  // launch + a term ≥ 5y, so it can NEVER precede launch — a drug cannot lose
  // exclusivity before it is on the market. This makes the commercial window ≥ the
  // regulatory term by construction and shifts with launch year.
  const regulatoryFloor = launchYear + binding.term;             // always > launch (term ≥ 5)
  const validPatent = patentLoeYear != null && patentLoeYear > launchYear ? patentLoeYear : null;
  const loeYear = Math.max(validPatent ?? 0, regulatoryFloor);   // ≥ regulatoryFloor > launch
  const basis: "patent" | "exclusivity" = validPatent != null && validPatent >= regulatoryFloor ? "patent" : "exclusivity";

  return {
    loeYear, basis, exclusivityYears: binding.term, isEstimate: basis === "exclusivity",
    provenance: basis === "patent"
      ? `pinned: cited patent/exclusivity expiry ${loeYear}`
      : (validPatent != null
          ? `estimate: ${binding.label} → LOE ${loeYear} (regulatory floor exceeds cited patent ${validPatent})`
          : `estimate: ${binding.label} → LOE ${loeYear} (launch + ${binding.term}y; rule-based, NOT a patent date)`),
  };
}
