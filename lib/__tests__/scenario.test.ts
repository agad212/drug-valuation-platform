import { describe, it, expect } from "vitest";
import { applyScenarioDeltas, weightedRollup } from "../scenario";
import { computeOutputs } from "../cashflow";
import type { Valuation } from "../types";

const base: Valuation = {
  peakSales: 1_000_000_000, discountRate: 0.12, launchYear: 2030, loeYear: 2043, ptrs: 0.25, devCostPV: 200_000_000, phase: "Phase 2",
  indications: [
    { id: "lead", name: "Lead", peakSales: 800_000_000, launchYear: 2030 },
    { id: "b", name: "B", peakSales: 400_000_000, launchYear: 2031 },
  ],
};

describe("scenario — applyScenarioDeltas transforms the input vector (no compute of its own)", () => {
  it("identity deltas leave the valuation (and its computeOutputs) unchanged — the base branch === base", () => {
    expect(computeOutputs(applyScenarioDeltas(base, {}))).toEqual(computeOutputs(base));
  });

  it("peakMult scales top-level AND every indication's peak", () => {
    const v = applyScenarioDeltas(base, { peakMult: 1.3 });
    expect(v.peakSales).toBeCloseTo(1.3e9);
    expect(v.indications![0].peakSales).toBeCloseTo(800_000_000 * 1.3);
    expect(v.indications![1].peakSales).toBeCloseTo(400_000_000 * 1.3);
    // higher peak → higher rNPV than base (monotone through the real engine)
    expect(computeOutputs(v).rnpv).toBeGreaterThan(computeOutputs(base).rnpv);
  });

  it("ptrsOverride sets the P override; launchDelta shifts launch (top + indications)", () => {
    const v = applyScenarioDeltas(base, { ptrsOverride: 0.4, launchDelta: 2 });
    expect(v.ptrs).toBe(0.4);
    expect(v.launchYear).toBe(2032);
    expect(v.indications![0].launchYear).toBe(2032);
    expect(v.indications![1].launchYear).toBe(2033);
  });
});

describe("scenario — weightedRollup is Σ(wᵢ/Σw)·valueᵢ (trivial aggregation)", () => {
  it("normalized weights: 0.25/0.5/0.25 over 100/200/300 = 200", () => {
    const r = weightedRollup([{ weight: 0.25, value: 100 }, { weight: 0.5, value: 200 }, { weight: 0.25, value: 300 }]);
    expect(r.expected).toBeCloseTo(200);
    expect(r.normalized).toBe(false); // Σ = 1
  });

  it("un-normalized weights are normalized + flagged (Σ ≠ 1)", () => {
    const r = weightedRollup([{ weight: 1, value: 100 }, { weight: 1, value: 300 }]); // Σ=2 → mean = 200
    expect(r.expected).toBeCloseTo(200);
    expect(r.totalWeight).toBe(2);
    expect(r.normalized).toBe(true);
  });

  it("all-zero weights → 0 (no divide-by-zero)", () => {
    expect(weightedRollup([{ weight: 0, value: 100 }]).expected).toBe(0);
  });
});
