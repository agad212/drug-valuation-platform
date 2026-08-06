import { describe, it, expect } from "vitest";
import { computeRevenuePV, computeOutputs } from "../cashflow";
import type { Valuation } from "../types";

// Revenue valued over the LOE CASE DISTRIBUTION (lib/loe-resolver → v.loeCases).
// The point: revenue PV is NONLINEAR in the LOE year, so E[revenuePV(LOE)] ≠ revenuePV(E[LOE]).

const BASE: Valuation = {
  asset: "TESTDRUG",
  peakSales: 1_000e6,
  launchYear: 2030,
  discountRate: 0.12,
  cogsPct: 0.2,
  taxRate: 0.21,
  workingCapitalPct: 0.1,
};

describe("revenue over the LOE case distribution", () => {
  it("CAPABILITY GATE: no loeCases → identical to the single-LOE computation", () => {
    const single = computeRevenuePV({ ...BASE, loeYear: 2040 });
    expect(computeRevenuePV({ ...BASE, loeYear: 2040, loeCases: undefined } as Valuation)).toBe(single);
    // A single case is also a no-op (nothing to average over).
    expect(computeRevenuePV({ ...BASE, loeYear: 2040, loeCases: [{ loeYear: 2040, weight: 1 }] } as Valuation)).toBe(single);
  });

  it("weights the cases: the result sits strictly BETWEEN the two single-LOE values", () => {
    const early = computeRevenuePV({ ...BASE, loeYear: 2038 });
    const late = computeRevenuePV({ ...BASE, loeYear: 2043 });
    expect(late).toBeGreaterThan(early); // more protected years → more revenue
    const weighted = computeRevenuePV({
      ...BASE, loeYear: 2038,
      loeCases: [{ loeYear: 2043, weight: 0.3 }, { loeYear: 2038, weight: 0.7 }],
    } as Valuation);
    expect(weighted).toBeGreaterThan(early);
    expect(weighted).toBeLessThan(late);
    // …and equals the explicit weighted sum.
    expect(weighted).toBeCloseTo(0.3 * late + 0.7 * early, 6);
  });

  it("E[revenuePV(LOE)] differs from revenuePV(E[LOE]) — valuing the distribution is not the same thing", () => {
    const cases = [{ loeYear: 2050, weight: 0.5 }, { loeYear: 2032, weight: 0.5 }];
    const expectation = computeRevenuePV({ ...BASE, loeYear: 2041, loeCases: cases } as Valuation);
    const atMeanYear = computeRevenuePV({ ...BASE, loeYear: 2041 }); // (2050+2032)/2
    expect(expectation).not.toBeCloseTo(atMeanYear, 2);
  });

  it("normalizes defensively: weights that do not sum to 1 cannot scale revenue", () => {
    const half = computeRevenuePV({ ...BASE, loeYear: 2040, loeCases: [{ loeYear: 2040, weight: 0.25 }, { loeYear: 2040, weight: 0.25 }] } as Valuation);
    expect(half).toBeCloseTo(computeRevenuePV({ ...BASE, loeYear: 2040 }), 6);
  });

  it("ignores malformed cases and falls back to the single LOE when none survive", () => {
    const single = computeRevenuePV({ ...BASE, loeYear: 2040 });
    expect(computeRevenuePV({ ...BASE, loeYear: 2040, loeCases: [{ loeYear: null, weight: 0.5 }, { weight: 0.5 }] } as any)).toBe(single);
    expect(computeRevenuePV({ ...BASE, loeYear: 2040, loeCases: [{ loeYear: 2043, weight: 0 }, { loeYear: 2038, weight: -1 }] } as any)).toBe(single);
  });

  it("SCOPE: an indication with its OWN loeYear does not inherit the lead's distribution", () => {
    // Exclusivity and method-of-use patents are indication-specific (21 USC 360cc(a) is per approved use),
    // so a second indication carrying its own LOE must be valued at that single year.
    const cases = [{ loeYear: 2050, weight: 0.5 }, { loeYear: 2038, weight: 0.5 }];
    const withOwnLoe = computeOutputs({
      ...BASE, loeYear: 2038, ptrs: 0.3, devCostPV: 0, loeCases: cases,
      indications: [
        { id: "a", name: "Lead", peakSales: 1_000e6, launchYear: 2030 },              // inherits the cases
        { id: "b", name: "Second", peakSales: 500e6, launchYear: 2030, loeYear: 2035 }, // its own LOE → single
      ],
    } as any);
    const secondAlone = computeRevenuePV({ ...BASE, peakSales: 500e6, loeYear: 2035 });
    const second = withOwnLoe.indicationOutputs.find((o) => o.id === "b")!;
    expect(second.revenuePV).toBeCloseTo(secondAlone, 6); // NOT distribution-weighted
    // The lead, with no own LOE, DOES use the distribution.
    const lead = withOwnLoe.indicationOutputs.find((o) => o.id === "a")!;
    expect(lead.revenuePV).not.toBeCloseTo(computeRevenuePV({ ...BASE, peakSales: 1_000e6, loeYear: 2038 }), 2);
  });
});
