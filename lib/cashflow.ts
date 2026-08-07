import type { Valuation, Indication } from "./types";
import { indicationLoa } from "./indication-loa";
import { inferTherapeuticArea } from "./financial-pins";

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

/**
 * Revenue PV. When the valuation carries an LOE CASE DISTRIBUTION (`loeCases`, produced by
 * lib/loe-resolver — e.g. 30% "the method-of-use patent holds → 2041" / 70% "it doesn't → the statutory
 * floor 2038"), this returns the weight-averaged revenue PV **over the cases**, i.e. E[revenuePV(LOE)].
 *
 * That is not cosmetic. Revenue PV is NONLINEAR in the LOE year (each extra protected year adds a
 * discounted full-price year, and the post-LOE tail is eroded), so E[revenuePV(LOE)] ≠ revenuePV(E[LOE]).
 * Valuing the distribution is therefore materially different from — and more correct than — valuing the
 * single weight-averaged LOE year.
 *
 * CAPABILITY GATE: no `loeCases` (or a single case) → the exact original single-LOE computation, so every
 * existing caller and the FROZEN deterministic fixtures are byte-identical.
 */
export function computeRevenuePV(v: Valuation): number {
  const rawCases = (v as any).loeCases;
  if (Array.isArray(rawCases) && rawCases.length > 1) {
    const cases = rawCases.filter(
      (c: any) => c && typeof c.loeYear === "number" && Number.isFinite(c.loeYear) && typeof c.weight === "number" && c.weight > 0,
    );
    const wsum = cases.reduce((s: number, c: any) => s + c.weight, 0);
    if (cases.length > 1 && wsum > 0) {
      // Normalize defensively so a malformed weight vector cannot scale revenue up or down.
      const pv = cases.reduce((s: number, c: any) => s + c.weight * revenuePvForLoeYear({ ...v, loeYear: c.loeYear }), 0);
      return pv / wsum;
    }
  }
  return revenuePvForLoeYear(v);
}

/** The single-LOE revenue PV — the original computation, unchanged. */
function revenuePvForLoeYear(v: Valuation): number {
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
  // 4.5 v1 — set when this row's P was DERIVED from its own remaining path (indication-loa.ts)
  // instead of inherited from the lead plan. Display-ready citation + arithmetic.
  ptrsBasis?: string;
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
      // ── 4.5 v1: a NON-LEAD indication's P and launch derive from ITS OWN remaining path ─────────
      // The lead's P is governed by the computed dev plan (v.ptrs); before this fix every other row
      // silently inherited it — the live 8/7 gap: a stalled Phase-2-completed oncology row carrying
      // the IPF program's 29%. Resolve-or-flag: an explicit ind.ptrs always wins; an unparseable
      // phase falls back to inheritance WITH a flag; the derivation names its literature basis.
      const loa = !isLead && ind.ptrs == null
        ? indicationLoa(ind.phase, inferTherapeuticArea(ind.name) === "oncology")
        : null;
      if (!isLead && ind.ptrs == null && !loa) {
        indicationFlags.push(`${ind.name}: no parseable phase — P INHERITED from the lead plan (${(ptrs * 100).toFixed(1)}%), which reflects the LEAD's trials, not this row's. Set the row's phase or an explicit P.`);
      }
      if (loa) {
        indicationFlags.push(
          `${ind.name}: P(approval) ${(loa.p * 100).toFixed(1)}% derived from its OWN remaining path — ${loa.basis}. ` +
          `No longer inheriting the lead plan's ${(ptrs * 100).toFixed(1)}% (which priced the lead's trials). ` +
          `Normal-prosecution assumption; mechanism-class haircut not applied (v1). Set an explicit P to override.`,
        );
      }

      const ownLaunch = ind.launchYear ?? v.launchYear;
      let effLaunch = ownLaunch;
      // Launch floor: a row still needing its remaining phases cannot launch earlier than the path
      // allows (live 8/7: the Phase-2-completed row claimed a 2028 launch — impossible with no
      // Phase 3 started). Same heuristic family as the trial-based launch estimate; RAISE-only.
      if (loa && !(ind as { alreadyLaunched?: boolean }).alreadyLaunched && ownLaunch != null && ownLaunch < loa.minLaunchYear) {
        indicationFlags.push(`${ind.name}: launch ${ownLaunch} precedes the earliest credible completion of its remaining path — floored to ${loa.minLaunchYear} (${loa.phaseBucket} → ~+${loa.minLaunchYear - new Date().getFullYear()}yr)`);
        effLaunch = loa.minLaunchYear;
      }
      const seqId = typeof rel === "string" && rel.startsWith("sequential-after:") ? rel.slice("sequential-after:".length) : null;
      if (seqId) {
        const prereqLaunch = byId.get(seqId)?.launchYear ?? indications[0]?.launchYear ?? v.launchYear;
        // Respect the 4.5 launch floor: the LATEST of (own/prereq resolution, remaining-path floor).
        if (prereqLaunch != null) effLaunch = Math.max(effLaunch ?? -Infinity, ind.launchYear != null ? Math.max(ind.launchYear, prereqLaunch) : prereqLaunch);
        if (effLaunch !== ownLaunch) indicationFlags.push(`${ind.name}: sequential-after ${byId.get(seqId)?.name ?? seqId} — launch shifted to ${effLaunch} (≥ prerequisite; refine with an explicit later launch)`);
      } else if (!isLead && ind.launchYear == null) {
        indicationFlags.push(`${ind.name}: no launch year — inherited the lead's (${v.launchYear}); revenue may be inflated — set its own launch or mark it sequential`);
      }

      const indPtrs = ind.ptrs ?? loa?.p ?? ptrs;
      // LOE cases are SCOPED per indication: exclusivity and method-of-use patents are indication-specific
      // (21 USC 360cc(a) is per approved use), so the lead's distribution must not leak onto an indication
      // that has its own LOE. Precedence: the indication's own cases → else, if it has its own loeYear, NO
      // distribution (that single year governs) → else inherit the lead/global distribution.
      const indLoeCases = (ind as any).loeCases ?? (ind.loeYear != null ? undefined : (v as any).loeCases);
      const indRevPV = computeRevenuePV({ ...v, peakSales: ind.peakSales ?? v.peakSales, launchYear: effLaunch, loeYear: ind.loeYear ?? v.loeYear, loeCases: indLoeCases } as Valuation);
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
      return { ...ind, revenuePV: indRevPV, rnpv: Math.round(contribution), ptrs: indPtrs, devCostPV: indDevCost, effLaunch, conditionalPWeight, ...(loa ? { ptrsBasis: loa.basis } : {}) };
    });

    if (n > 1) {
      indicationFlags.push(`eNPV is correct in expectation; the CI assumes independence and OVERSTATES diversification for a same-mechanism asset (a shared safety/PK failure kills correlated indications) — a later risk-profile refinement`);
    }

    // 4.6 — a STALLED or DISCONTINUED program contributing to the headline is surfaced with its share
    // named (observe-and-flag: the value is NOT adjusted — a reactivation-probability discount would be
    // an invented constant; the flag lets a human judge whether ~27% of the headline should ride on a
    // program with no development activity). Citation-gated: an uncited status still surfaces, marked
    // as uncited, so a claim is never silently dropped OR silently trusted.
    {
      const totalRnpvForShare = indicationOutputs.reduce((s, i) => s + i.rnpv, 0);
      for (const io of indicationOutputs) {
        const status = (io as Indication).developmentStatus;
        if (status !== "stalled" && status !== "discontinued") continue;
        const basis = (io as Indication).developmentStatusBasis?.trim();
        const share = totalRnpvForShare > 0 && io.rnpv > 0 ? ` — ${Math.round((io.rnpv / totalRnpvForShare) * 100)}% of the headline rides on it` : "";
        indicationFlags.push(
          `${io.name}: development ${status.toUpperCase()}${basis ? ` (${basis})` : " (status UNCITED — verify)"}${share}; ` +
          `value included as-if-active — deprioritize or remove the row if the program will not be prosecuted`,
        );
      }
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

