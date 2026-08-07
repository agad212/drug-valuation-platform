import { describe, it, expect } from "vitest";
import { computeOutputs, computeRevenuePV } from "../cashflow";
import type { Valuation } from "../types";

// computeRevenuePV discounts from new Date().getFullYear(), so absolute PVs drift with the run date.
// Every assertion below is therefore RELATIVE (structural Σ == rows; sequential < independent;
// conditional == P-weighted) — never a hard-coded dollar figure.

const base: Valuation = {
  peakSales: 1_000_000_000,
  launchYear: 2030,
  loeYear: 2043,
  discountRate: 0.12,
  ptrs: 0.3,
  devCostPV: 200_000_000,
  phase: "Phase 2",
};

describe("cashflow — single-indication path is unchanged (FROZEN-safe: the new structural code is gated on >0 indications but reduces to the old arithmetic at ≤1)", () => {
  it("no indications → rnpv = round(ptrs·revPV − devCost); indicationFlags empty", () => {
    const out = computeOutputs(base);
    const revPV = computeRevenuePV(base);
    expect(out.rnpv).toBe(Math.round(0.3 * revPV - 200_000_000));
    expect(out.indicationOutputs).toEqual([]);
    expect(out.indicationFlags).toEqual([]);
  });

  it("exactly ONE indication reduces to the single-indication arithmetic (no flags, no shift)", () => {
    const out = computeOutputs({ ...base, indications: [{ id: "a", name: "A" }] });
    const revPV = computeRevenuePV(base);
    // n=1 → globalDevCostShare = full devCostPV; independent; effLaunch = own launch
    expect(out.rnpv).toBe(Math.round(0.3 * revPV - 200_000_000));
    expect(out.indicationFlags).toEqual([]);
    expect(out.indicationOutputs).toHaveLength(1);
  });
});

describe("cashflow — INDEPENDENT aggregation is Σ of independently-risked indications (never pooled × one P)", () => {
  const v: Valuation = {
    ...base,
    indications: [
      { id: "lead", name: "Lead", peakSales: 800_000_000, ptrs: 0.3, launchYear: 2030 },
      { id: "second", name: "Second", peakSales: 400_000_000, ptrs: 0.15, launchYear: 2030 },
    ],
  };

  it("headline rnpv == Σ per-indication structural contributions (exact, the A8 invariant at the engine)", () => {
    const out = computeOutputs(v);
    const sum = out.indicationOutputs.reduce((s, o) => s + o.rnpv, 0);
    expect(out.rnpv).toBe(sum);
  });

  it("each indication uses its OWN P — the structural Σ is strictly below pooled revenue × the lead's P", () => {
    const out = computeOutputs(v);
    const revLead = computeRevenuePV({ ...base, peakSales: 800_000_000, launchYear: 2030 });
    const revSecond = computeRevenuePV({ ...base, peakSales: 400_000_000, launchYear: 2030 });
    const pooledOneP = 0.3 * (revLead + revSecond) - 200_000_000; // the naive bug
    expect(out.rnpv).toBeLessThan(pooledOneP);
    // and it equals the hand-computed Σ (own P each, cost split evenly)
    const expected =
      Math.round(0.3 * revLead - 100_000_000) + Math.round(0.15 * revSecond - 100_000_000);
    expect(out.rnpv).toBe(expected);
  });

  it("an unstated relationship on a non-lead surfaces an 'assumed independent' flag + the correlation caveat", () => {
    const out = computeOutputs(v);
    expect(out.indicationFlags.some((f) => /Second/.test(f) && /assumed INDEPENDENT/i.test(f))).toBe(true);
    expect(out.indicationFlags.some((f) => /correct in expectation/i.test(f) && /diversification/i.test(f))).toBe(true);
  });

  it("a non-lead with no launch year inherits the lead's — and is flagged for it", () => {
    const out = computeOutputs({
      ...base,
      indications: [
        { id: "lead", name: "Lead", peakSales: 800_000_000, launchYear: 2030 },
        { id: "second", name: "Second", peakSales: 400_000_000 }, // no launch year
      ],
    });
    expect(out.indicationFlags.some((f) => /Second/.test(f) && /no launch year/i.test(f))).toBe(true);
  });
});

describe("cashflow — 4.6 deprioritized-indication flag (observe-and-flag, value NOT adjusted)", () => {
  const mk = (status?: "active" | "stalled" | "discontinued", basis?: string): Valuation => ({
    ...base,
    indications: [
      { id: "lead", name: "Lead", peakSales: 800_000_000, ptrs: 0.3, launchYear: 2030 },
      { id: "second", name: "Second", peakSales: 400_000_000, ptrs: 0.15, launchYear: 2030,
        developmentStatus: status, developmentStatusBasis: basis },
    ],
  });

  it("a CITED stalled indication is flagged with its basis and its share of the headline", () => {
    const out = computeOutputs(mk("stalled", "no development reports since 2017; dropped from sponsor pipeline page"));
    const flag = out.indicationFlags.find((f) => /Second: development STALLED/.test(f));
    expect(flag).toBeTruthy();
    expect(flag!).toMatch(/no development reports since 2017/);
    expect(flag!).toMatch(/% of the headline rides on it/);
    // Observe-and-flag: the VALUE is identical to the active case (no invented reactivation discount).
    expect(out.rnpv).toBe(computeOutputs(mk("active")).rnpv);
  });

  it("an UNCITED stalled status still surfaces — marked as uncited, never silently dropped or trusted", () => {
    const out = computeOutputs(mk("stalled"));
    const flag = out.indicationFlags.find((f) => /Second: development STALLED/.test(f));
    expect(flag).toBeTruthy();
    expect(flag!).toMatch(/UNCITED — verify/);
  });

  it("discontinued flags too; active or absent status does not", () => {
    expect(computeOutputs(mk("discontinued", "sponsor terminated the program")).indicationFlags.some((f) => /DISCONTINUED/.test(f))).toBe(true);
    expect(computeOutputs(mk("active")).indicationFlags.some((f) => /development (STALLED|DISCONTINUED)/.test(f))).toBe(false);
    expect(computeOutputs(mk(undefined)).indicationFlags.some((f) => /development (STALLED|DISCONTINUED)/.test(f))).toBe(false);
  });
});

describe("cashflow — SEQUENTIAL: a later indication launches no earlier than its prerequisite (revenue shifts later)", () => {
  it("sequential-after shifts launch to the prerequisite's, lowering that indication's revenue PV vs an independent early launch", () => {
    const out = computeOutputs({
      ...base,
      launchYear: 2034,
      indications: [
        { id: "lead", name: "Lead", peakSales: 800_000_000, ptrs: 0.3, launchYear: 2034 },
        { id: "s", name: "S", peakSales: 400_000_000, ptrs: 0.3, launchYear: 2030, indicationRelationship: "sequential-after:lead" },
      ],
    });
    const seqSecond = out.indicationOutputs.find((o) => o.id === "s")!;
    // independent counterfactual: S launching at its own 2030 (earlier → less discounting → higher PV)
    const independentEarly = computeRevenuePV({ ...base, peakSales: 400_000_000, launchYear: 2030 });
    expect(seqSecond.revenuePV).toBeLessThan(independentEarly);
    // ADDITIVE surfacing: the RESOLVED effective launch is floored at the prerequisite's (2034), exposed
    // for the Gantt to read (never re-derive).
    expect(seqSecond.effLaunch).toBe(2034);
    expect(seqSecond.conditionalPWeight).toBeUndefined();
    expect(out.indicationFlags.some((f) => /^S:|S:/.test(f) && /sequential-after/i.test(f) && /shifted/i.test(f))).toBe(true);
  });
});

describe("cashflow — per-indication dev-cost BASIS: stripping ind.devCostPV routes to the risk-adjusted share (the $3M-IPF fix)", () => {
  // When a dev plan governs, index.tsx passes chartValuation.devCostPV = the risk-adjusted total AND
  // strips per-indication devCostPV, so cashflow's `ind.devCostPV ?? globalDevCostShare` falls to the
  // SHARE. computeOutputs' math is unchanged — this proves the two INPUT paths diverge and the stripped
  // one reconciles to the plan.
  const riskAdj = 27_000_000; // governing risk-adjusted plan cost
  const inds = [
    { id: "ipf", name: "IPF", peakSales: 1_500_000_000, ptrs: 0.34, launchYear: 2032, loeYear: 2037, devCostPV: 550_000_000 },
    { id: "onc", name: "Onc", peakSales: 450_000_000, ptrs: 0.34, launchYear: 2028, loeYear: 2037, devCostPV: 300_000_000 },
  ];

  it("WITH nominal per-indication devCostPV (the bug): rows subtract the nominal cost; Σ = 850M ≠ 27M plan", () => {
    const out = computeOutputs({ ...base, devCostPV: riskAdj, indications: inds });
    expect(out.indicationOutputs.find((o) => o.id === "ipf")!.devCostPV).toBe(550_000_000); // nominal wins via ??
    expect(out.devCostPV).toBe(850_000_000); // 31× the 27M plan → the cost-basis divergence B2 catches
  });

  it("STRIPPED per-indication devCostPV (the fix): rows use the risk-adjusted share; Σ reconciles to 27M", () => {
    const stripped = inds.map((i) => ({ ...i, devCostPV: undefined }));
    const out = computeOutputs({ ...base, devCostPV: riskAdj, indications: stripped });
    const share = riskAdj / 2; // globalDevCostShare
    const ipf = out.indicationOutputs.find((o) => o.id === "ipf")!;
    expect(ipf.devCostPV).toBe(share);          // 13.5M, not 550M
    expect(out.devCostPV).toBe(riskAdj);        // Σ shares = 27M, reconciles with the plan
    // IPF rNPV jumps from ~$0 (nominal-crushed) to its risk-adjusted value (own P × RevPV − share)
    expect(ipf.rnpv).toBe(Math.round(0.34 * ipf.revenuePV - share));
    expect(ipf.rnpv).toBeGreaterThan(100_000_000); // no longer eaten by the nominal cost
  });
});

describe("cashflow — turning the structure generator ON is a NO-OP until a non-independent relationship (all-independent == today)", () => {
  const inds = [
    { id: "lead", name: "Lead", peakSales: 800_000_000, ptrs: 0.3, launchYear: 2030 },
    { id: "b", name: "B", peakSales: 400_000_000, ptrs: 0.15, launchYear: 2030 },
    { id: "c", name: "C", peakSales: 300_000_000, ptrs: 0.2, launchYear: 2031 },
  ];

  it("indicationRelationship 'independent' on every non-lead → byte-identical NUMBERS to leaving it unset (the default)", () => {
    const today = computeOutputs({ ...base, indications: inds });
    const explicitIndep = computeOutputs({
      ...base,
      indications: inds.map((i, idx) => (idx === 0 ? i : { ...i, indicationRelationship: "independent" })),
    });
    expect(explicitIndep.rnpv).toBe(today.rnpv);
    expect(explicitIndep.revenuePV).toBe(today.revenuePV);
    expect(explicitIndep.indicationOutputs.map((o) => o.rnpv)).toEqual(today.indicationOutputs.map((o) => o.rnpv));
    // (only the FLAGS differ — an explicit-independent isn't tagged "relationship unstated" — never the numbers)
  });
});

describe("cashflow — CONDITIONAL: a dependent indication's whole contribution is P-weighted by P(prerequisite success)", () => {
  it("conditional-on P-weights the contribution (= P_prereq × standalone), strictly below the standalone value", () => {
    const out = computeOutputs({
      ...base,
      indications: [
        { id: "lead", name: "Lead", peakSales: 800_000_000, ptrs: 0.3, launchYear: 2030 },
        { id: "dep", name: "Dep", peakSales: 400_000_000, ptrs: 0.15, launchYear: 2030, indicationRelationship: "conditional-on:lead" },
      ],
    });
    const dep = out.indicationOutputs.find((o) => o.id === "dep")!;
    const standalone = 0.15 * dep.revenuePV - 100_000_000; // own P, its cost share
    const expected = Math.round(0.3 * standalone); // P-weighted by the lead's P(success)=0.30
    expect(dep.rnpv).toBe(expected);
    expect(dep.rnpv).toBeLessThan(Math.round(standalone)); // P-weighting reduces it
    // ADDITIVE surfacing: the conditional P-weight (the prerequisite's P) is exposed for the Gantt gate.
    expect(dep.conditionalPWeight).toBe(0.3);
    expect(dep.effLaunch).toBe(2030);
    expect(out.indicationFlags.some((f) => /Dep/.test(f) && /conditional on/i.test(f) && /P-weighted/i.test(f))).toBe(true);
  });

  it("even conditional, headline rnpv == Σ per-indication structural contributions (A8 never false-fires)", () => {
    const out = computeOutputs({
      ...base,
      indications: [
        { id: "lead", name: "Lead", peakSales: 800_000_000, ptrs: 0.3, launchYear: 2030 },
        { id: "dep", name: "Dep", peakSales: 400_000_000, ptrs: 0.15, launchYear: 2030, indicationRelationship: "conditional-on:lead" },
      ],
    });
    expect(out.rnpv).toBe(out.indicationOutputs.reduce((s, o) => s + o.rnpv, 0));
  });
});
