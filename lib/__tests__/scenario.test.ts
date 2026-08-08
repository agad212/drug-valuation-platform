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

describe("scenario - elicitedPeakMultipliers (module 3: reactive derivation, 8/8 review fixes)", () => {
  const mk = (bear?: number, bull?: number, leadPeak = 800_000_000): Valuation => ({
    ...base,
    indications: [
      { id: "lead", name: "Lead", peakSales: leadPeak, launchYear: 2030, bearPeakM: bear, bullPeakM: bull },
      { id: "b", name: "B", peakSales: 400_000_000, launchYear: 2031 },
    ],
  });

  it("derives full-precision multipliers from the lead's elicited p05/p95", async () => {
    const { elicitedPeakMultipliers } = await import("../scenario");
    const r = elicitedPeakMultipliers(mk(300, 1400)); // lead peak $800M
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bearMult).toBeCloseTo(300 / 800, 4);
      expect(r.bullMult).toBeCloseTo(1400 / 800, 4);
    }
  });

  it("nothing elicited -> not ok with a NULL reason (the normal quiet case)", async () => {
    const { elicitedPeakMultipliers } = await import("../scenario");
    const r = elicitedPeakMultipliers(mk(undefined, undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeNull();
  });

  it("incoherent (stale) bounds -> not ok with a SURFACED reason (never a silent fallback)", async () => {
    const { elicitedPeakMultipliers } = await import("../scenario");
    const r = elicitedPeakMultipliers(mk(300, 700)); // bull $700M < lead peak $800M
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/incoherent|stale/i);
  });

  it("a legitimate elicited p05 of exactly $0M is honored (multiplier 0), not dropped", async () => {
    const { elicitedPeakMultipliers } = await import("../scenario");
    const r = elicitedPeakMultipliers(mk(0, 1400));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bearMult).toBe(0);
  });

  it("tiny bear ratios do NOT collapse to 0 (the .toFixed(2) bug zeroed the whole branch)", async () => {
    const { elicitedPeakMultipliers } = await import("../scenario");
    const r = elicitedPeakMultipliers(mk(0.02, 1400)); // $0.02M / $800M = 2.5e-5 -> rounds to 0 at 4dp
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bearMult).toBeGreaterThan(0);
  });

  it("near-1 ratios do NOT round to exactly 1 (applyScenarioDeltas treats mult===1 as no-op)", async () => {
    const { elicitedPeakMultipliers } = await import("../scenario");
    const r = elicitedPeakMultipliers(mk(300, 800.02)); // 800.02/800 rounds to 1.0000 at 4dp
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bullMult).toBeGreaterThan(1);
  });
});
