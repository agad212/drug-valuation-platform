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
  // ADDITIVE render-support (no math change): the RESOLVED effective launch used for revenue (a
  // sequential-after indication's launch floored at its prerequisite's) and the conditional P-weight
  // applied to its contribution (present only for conditional-on). The multi-indication Gantt READS
  // these to place the stagger / gate from resolved data — it never re-derives the floor.
  effLaunch?: number;
  conditionalPWeight?: number;
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
  indicationFlags: string[]; // structured multi-indication assumptions/flags (surfaced, never prose-only)
} {
  const { ptrs: computedPtrs, mechLabel } = computePTRS(v);
  const ptrs = v.ptrs ?? computedPtrs;
  const devCostPV = Math.max(0, v.devCostPV ?? 0);

  // ── Multi-indication mode ──────────────────────────────────────────────────
  if (v.indications && v.indications.length > 0) {
    const n = v.indications.length;
    const globalDevCostShare = devCostPV / Math.max(1, n);
    const indications = v.indications;
    const byId = new Map(indications.map((ind) => [ind.id, ind]));
    const indicationFlags: string[] = [];

    // Each indication is risked under its RESOLVED structure — never a single blanket P on pooled
    // revenue. Lead (index 0) is always independent; others read indicationRelationship (default
    // independent + surfaced assumption). rnpv per row is the STRUCTURAL contribution to the aggregate.
    const indicationOutputs: IndicationOutput[] = indications.map((ind, idx) => {
      const isLead = idx === 0;
      const rel = isLead ? "independent" : (ind.indicationRelationship ?? "independent");
      if (!isLead && !ind.indicationRelationship) {
        indicationFlags.push(`${ind.name}: relationship unstated — assumed INDEPENDENT (optimistic; set conditional/sequential if the go-decision or timeline depends on another indication)`);
      }

      // Effective launch. sequential-after:<id> → no earlier than the prerequisite's launch (fixes a
      // later indication silently inheriting the lead's early launch). Otherwise own launch, falling
      // back to the drug's — flagged for a non-lead, since inheriting the lead's early launch inflates PV.
      const ownLaunch = ind.launchYear ?? v.launchYear;
      let effLaunch = ownLaunch;
      const seqId = typeof rel === "string" && rel.startsWith("sequential-after:") ? rel.slice("sequential-after:".length) : null;
      if (seqId) {
        const prereqLaunch = byId.get(seqId)?.launchYear ?? indications[0]?.launchYear ?? v.launchYear;
        if (prereqLaunch != null) effLaunch = ind.launchYear != null ? Math.max(ind.launchYear, prereqLaunch) : prereqLaunch;
        if (effLaunch !== ownLaunch) indicationFlags.push(`${ind.name}: sequential-after ${byId.get(seqId)?.name ?? seqId} — launch shifted to ${effLaunch} (≥ prerequisite; refine with an explicit later launch)`);
      } else if (!isLead && ind.launchYear == null) {
        indicationFlags.push(`${ind.name}: no launch year — inherited the lead's (${v.launchYear}); revenue may be inflated — set its own launch or mark it sequential`);
      }

      const indPtrs = ind.ptrs ?? ptrs;
      const indRevPV = computeRevenuePV({ ...v, peakSales: ind.peakSales ?? v.peakSales, launchYear: effLaunch, loeYear: ind.loeYear ?? v.loeYear });
      const indDevCost = ind.devCostPV ?? globalDevCostShare;
      const standalone = indPtrs * indRevPV - indDevCost;

      // conditional-on:<id> → this indication only proceeds if its prerequisite succeeds → P-weight the
      // WHOLE contribution by P(prerequisite success). (Mechanism read-through into its PRIOR — raising
      // its own P — is a deferred pass; its P stays standalone here.)
      const condId = typeof rel === "string" && rel.startsWith("conditional-on:") ? rel.slice("conditional-on:".length) : null;
      let contribution = standalone;
      let conditionalPWeight: number | undefined;
      if (condId) {
        const pPrereq = byId.get(condId)?.ptrs ?? ptrs;
        contribution = pPrereq * standalone;
        conditionalPWeight = pPrereq;
        indicationFlags.push(`${ind.name}: conditional on ${byId.get(condId)?.name ?? condId} — contribution P-weighted by P(prereq success)=${(pPrereq * 100).toFixed(0)}%`);
      }

      // effLaunch + conditionalPWeight are ADDITIVE render-support (no math change): the RESOLVED launch
      // used for revenue and the conditional weight applied — the Gantt reads these to place the
      // stagger/gate from resolved data (never re-deriving the floor).
      return { ...ind, revenuePV: indRevPV, rnpv: Math.round(contribution), ptrs: indPtrs, devCostPV: indDevCost, effLaunch, conditionalPWeight };
    });

    if (n > 1) {
      indicationFlags.push(`eNPV is correct in expectation; the CI assumes independence and OVERSTATES diversification for a same-mechanism asset (a shared safety/PK failure kills correlated indications) — a later risk-profile refinement`);
    }

    const revenuePV = indicationOutputs.reduce((s, i) => s + i.revenuePV, 0);
    // Headline = Σ of the per-indication STRUCTURAL contributions (each already at its own P, own launch,
    // and any conditional P-weight) — never pooled revenue × one P. Shared dev cost is counted once (each
    // row carries its own share; the sum is the total).
    const rnpv = Math.round(indicationOutputs.reduce((s, i) => s + i.rnpv, 0));
    const totalDevCostPV = indicationOutputs.reduce((s, i) => s + i.devCostPV, 0) || devCostPV;
    const roi = totalDevCostPV > 0 ? rnpv / totalDevCostPV : undefined;
    return { ptrs, revenuePV, devCostPV: totalDevCostPV, rnpv, roi, mechLabel, indicationOutputs, indicationFlags };
  }

  // ── Single-indication mode ─────────────────────────────────────────────────
  const revenuePV = computeRevenuePV(v);
  const rnpv = Math.round(ptrs * revenuePV - devCostPV);
  const roi = devCostPV > 0 ? rnpv / devCostPV : undefined;
  return { ptrs, revenuePV, devCostPV, rnpv, roi, mechLabel, indicationOutputs: [], indicationFlags: [] };
}

