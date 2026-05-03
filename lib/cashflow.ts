import type { Valuation, Indication } from "./types";

// ─── Mechanism-based PTRS scoring ────────────────────────────────────────────

type MechEntry = { keywords: string[]; adjustment: number; label: string };

const MECHANISM_TABLE: MechEntry[] = [
  // Well-validated — multiple approvals, high historical PoS
  { keywords: ["pd-1", "pd1", "pembrolizumab", "nivolumab"], adjustment: 0.08, label: "PD-1 (well-validated)" },
  { keywords: ["pd-l1", "pdl1", "atezolizumab", "durvalumab", "avelumab"], adjustment: 0.08, label: "PD-L1 (well-validated)" },
  { keywords: ["bcr-abl", "bcrabl", "imatinib", "dasatinib", "nilotinib"], adjustment: 0.08, label: "BCR-ABL (well-validated)" },
  { keywords: ["her2", "trastuzumab", "pertuzumab", "tucatinib"], adjustment: 0.07, label: "HER2 (well-validated)" },
  { keywords: ["egfr", "erlotinib", "gefitinib", "osimertinib", "afatinib"], adjustment: 0.07, label: "EGFR (well-validated)" },
  { keywords: ["alk", "crizotinib", "alectinib", "lorlatinib", "brigatinib"], adjustment: 0.07, label: "ALK (well-validated)" },
  { keywords: ["btk", "ibrutinib", "acalabrutinib", "zanubrutinib"], adjustment: 0.07, label: "BTK (well-validated)" },
  { keywords: ["cdk4", "cdk6", "palbociclib", "ribociclib", "abemaciclib"], adjustment: 0.07, label: "CDK4/6 (well-validated)" },
  { keywords: ["ctla-4", "ctla4", "ipilimumab", "tremelimumab"], adjustment: 0.06, label: "CTLA-4 (well-validated)" },
  { keywords: ["vegf", "vegfr", "bevacizumab", "ramucirumab", "axitinib"], adjustment: 0.06, label: "VEGF/VEGFR (well-validated)" },
  { keywords: ["parp", "olaparib", "rucaparib", "niraparib", "talazoparib"], adjustment: 0.06, label: "PARP (well-validated)" },
  { keywords: ["braf", "vemurafenib", "dabrafenib", "encorafenib"], adjustment: 0.06, label: "BRAF (well-validated)" },
  { keywords: ["adc", "antibody-drug conjugate", "antibody drug conjugate"], adjustment: 0.05, label: "ADC (validated class)" },
  { keywords: ["mtor", "everolimus", "temsirolimus"], adjustment: 0.05, label: "mTOR (validated)" },
  { keywords: ["jak", "jak1", "jak2", "ruxolitinib", "tofacitinib", "baricitinib", "upadacitinib"], adjustment: 0.05, label: "JAK (validated)" },
  { keywords: ["idh1", "idh2", "enasidenib", "ivosidenib", "olutasidenib"], adjustment: 0.05, label: "IDH1/2 (validated)" },
  { keywords: ["flt3", "midostaurin", "gilteritinib", "quizartinib"], adjustment: 0.05, label: "FLT3 (validated)" },
  { keywords: ["ret", "selpercatinib", "pralsetinib"], adjustment: 0.05, label: "RET (validated)" },
  { keywords: ["smoothened", "hedgehog", "smo", "vismodegib", "sonidegib"], adjustment: 0.04, label: "Hedgehog/SMO (validated)" },
  { keywords: ["kras", "krasg12c", "kras g12c", "sotorasib", "adagrasib"], adjustment: 0.03, label: "KRAS (recently validated)" },

  // Mixed evidence
  { keywords: ["pi3k", "pi3k alpha", "idelalisib", "copanlisib", "alpelisib"], adjustment: -0.02, label: "PI3K (mixed evidence)" },
  { keywords: ["hdac", "vorinostat", "romidepsin", "panobinostat"], adjustment: -0.02, label: "HDAC (mixed evidence)" },
  { keywords: ["ras", "nras", "hras"], adjustment: -0.02, label: "RAS (difficult target, mixed)" },

  // Historically low success
  { keywords: ["mdm2", "mdm-2"], adjustment: -0.04, label: "MDM2 (historically difficult)" },
  { keywords: ["stat3", "stat-3"], adjustment: -0.05, label: "STAT3 (historically low PoS)" },
  { keywords: ["wnt", "beta-catenin", "β-catenin", "frizzled"], adjustment: -0.06, label: "Wnt/β-catenin (historically low PoS)" },
  { keywords: ["notch", "gamma secretase"], adjustment: -0.05, label: "Notch (historically low PoS)" },
  { keywords: ["myc", "c-myc"], adjustment: -0.06, label: "MYC (historically very difficult)" },

  // Generic modifiers
  { keywords: ["best-in-class", "best in class"], adjustment: 0.04, label: "Best-in-class (validated mechanism)" },
  { keywords: ["validated target", "validated mechanism"], adjustment: 0.04, label: "Validated target" },
  { keywords: ["first-in-class", "first in class", "novel mechanism"], adjustment: -0.03, label: "First-in-class (unvalidated)" },
  { keywords: ["novel target", "unvalidated"], adjustment: -0.04, label: "Novel/unvalidated target" },
];

export function scoreMechanism(mechanism: string): { adjustment: number; matched: string[] } {
  const lower = (mechanism || "").toLowerCase();
  let adjustment = 0;
  const matched: string[] = [];

  for (const entry of MECHANISM_TABLE) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      adjustment += entry.adjustment;
      matched.push(entry.label);
    }
  }

  return { adjustment: clamp(-0.15, 0.15, adjustment), matched };
}

// ─── PTRS ─────────────────────────────────────────────────────────────────────

export function computePTRS(v: Valuation): { ptrs: number; mechLabel: string } {
  const baseByPhase: Record<string, number> = {
    Preclinical: 0.07,
    "Phase 1": 0.14,
    "Phase 2": 0.25,
    "Phase 3": 0.50,
    Filed: 0.70,
    Approved: 1.0,
  };
  const base = baseByPhase[v.phase || "Phase 2"] ?? 0.25;
  const { adjustment, matched } = scoreMechanism(v.mechanism || "");
  const ptrs = clamp01(base + adjustment);
  const mechLabel = matched.length > 0 ? matched.join(", ") : "No mechanism match — using phase baseline";
  return { ptrs, mechLabel };
}

// ─── Revenue PV ───────────────────────────────────────────────────────────────

export function computeRevenuePV(v: Valuation): number {
  if (!v.launchYear || !v.peakSales) return 0;
  // If LOE missing or before launch, default to launchYear + 10
  const effectiveLoeYear = (!v.loeYear || v.loeYear < v.launchYear)
    ? v.launchYear + 10
    : v.loeYear;
  const years: number[] = [];
  for (let y = v.launchYear; y <= effectiveLoeYear + 1; y++) years.push(y);

  const ramps: Record<number, number> = { 0: 0.2, 1: 0.5, 2: 0.8, 3: 1.0 };
  const disc = v.discountRate ?? 0.12;
  const cogs = v.cogsPct ?? 0.2;
  const tax = v.taxRate ?? 0.21;
  const wc = v.workingCapitalPct ?? 0.1;
  const royalty = v.avgRoyalty ?? 0.15;

  const now = new Date().getFullYear();
  let pv = 0;
  let prevRevenue = 0;

  years.forEach((yr, i) => {
    const t = yr - now;
    let pct = 1.0;
    if (i <= 3) pct = ramps[i] ?? 1.0;
    else if (yr <= effectiveLoeYear) pct = 1.0;
    else pct = 0.5;

    const revenue = (v.peakSales || 0) * pct;

    let cash = 0;
    if (v.ownerType === "Licensor") {
      cash = royalty * revenue;
    } else {
      const gross = revenue * (1 - cogs);
      const wcDelta = (revenue - prevRevenue) * wc;
      const taxable = Math.max(0, gross - wcDelta);
      cash = taxable * (1 - tax);
    }

    const df = 1 / Math.pow(1 + disc, Math.max(0, t));
    pv += cash * df;
    prevRevenue = revenue;
  });

  return Math.max(0, Math.round(pv));
}

// ─── Indication output type ────────────────────────────────────────────────────

export type IndicationOutput = Indication & {
  revenuePV: number;
  rnpv: number;
  ptrs: number;
  devCostPV: number;
};

// ─── Outputs ──────────────────────────────────────────────────────────────────

export function computeOutputs(v: Valuation): {
  ptrs: number;
  revenuePV: number;
  devCostPV: number;
  rnpv: number;
  roi: number | undefined;
  mechLabel: string;
  indicationOutputs: IndicationOutput[];
} {
  const { ptrs: computedPtrs, mechLabel } = computePTRS(v);
  const ptrs = v.ptrs ?? computedPtrs;
  const devCostPV = Math.max(0, v.devCostPV ?? 0);

  // ── Multi-indication mode ──────────────────────────────────────────────────
  if (v.indications && v.indications.length > 0) {
    const n = v.indications.length;
    const globalDevCostShare = devCostPV / Math.max(1, n);
    const indicationOutputs: IndicationOutput[] = v.indications.map((ind) => {
      const indPtrs = ind.ptrs ?? ptrs;
      const indRevPV = computeRevenuePV({
        ...v,
        peakSales: ind.peakSales ?? v.peakSales,
        launchYear: ind.launchYear ?? v.launchYear,
        loeYear: ind.loeYear ?? v.loeYear,
      });
      const indDevCost = ind.devCostPV ?? globalDevCostShare;
      return { ...ind, revenuePV: indRevPV, rnpv: Math.round(indPtrs * indRevPV - indDevCost), ptrs: indPtrs, devCostPV: indDevCost };
    });

    const revenuePV = indicationOutputs.reduce((s, i) => s + i.revenuePV, 0);
    // rnpv per indication already has devCost deducted
    const rnpv = Math.round(indicationOutputs.reduce((s, i) => s + i.rnpv, 0));
    // Use sum of per-indication dev costs for the metric card (overrides blank global)
    const totalDevCostPV = indicationOutputs.reduce((s, i) => s + i.devCostPV, 0) || devCostPV;
    const roi = totalDevCostPV > 0 ? rnpv / totalDevCostPV : undefined;
    return { ptrs, revenuePV, devCostPV: totalDevCostPV, rnpv, roi, mechLabel, indicationOutputs };
  }

  // ── Single-indication mode ─────────────────────────────────────────────────
  const revenuePV = computeRevenuePV(v);
  const rnpv = Math.round(ptrs * revenuePV - devCostPV);
  const roi = devCostPV > 0 ? rnpv / devCostPV : undefined;
  return { ptrs, revenuePV, devCostPV, rnpv, roi, mechLabel, indicationOutputs: [] };
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clamp(min: number, max: number, x: number) { return Math.max(min, Math.min(max, x)); }
