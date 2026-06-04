import type { Valuation, Indication } from "./types";

// ─── Phase-baseline P(approval) fallback ──────────────────────────────────────
//
// This is the fallback used while the Approval Probability pipeline runs.
// Real P(approval) comes from the unified engine:
//   Layer 1 (/api/ptrs-score) → MSS, σ²
//   Dev Plan (/api/dev-plan)  → stage-by-stage Φ(z) × Bayesian updates
//   computeApprovalProbability() in lib/ptrs.ts → single P(approval) number
//
// Phase baselines from DiMasi / Hay et al. industry data.

export function computePTRS(v: Valuation): { ptrs: number; mechLabel: string } {
  const baseByPhase: Record<string, number> = {
    Preclinical: 0.07,
    "Phase 1":   0.14,
    "Phase 2":   0.25,
    "Phase 3":   0.50,
    Filed:       0.70,
    Approved:    1.0,
  };
  const ptrs = baseByPhase[v.phase || "Phase 2"] ?? 0.25;
  return {
    ptrs,
    mechLabel: `Phase baseline · run Auto-Valuate for full Approval Probability analysis`,
  };
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

