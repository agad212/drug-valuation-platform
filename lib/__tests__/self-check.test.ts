import { describe, it, expect } from "vitest";
import {
  selfCheck,
  EROI_CEILING_PROVISIONAL,
  type ValuationView,
  type OptionView,
} from "../self-check";

// ── A representative FINISHED valuation that passes every Class-A check (and B1). Internally
//    consistent: eNPV = pApproval·revenuePVM − cost; eROI = eNPV/cost; cum non-increasing; etc.
function good(overrides: Partial<ValuationView> = {}): ValuationView {
  return {
    label: "good",
    pApproval: 0.17,
    pAllTrialsSuccess: 0.2,
    stageProbs: [0.5, 0.4],
    stageCumProbs: [0.5, 0.2],
    ptrs: 0.17,
    ptrsCI: { lower: 0.1, upper: 0.25 },
    eNPVM: 140,
    revenuePVM: 2000,
    riskAdjCostM: 200,
    eROI: 0.7,
    launchYear: 2030,
    loeYear: 2043,
    impliedLaunchYear: 2030,
    totalDurationMonths: 48,
    asOfYear: 2026,
    ...overrides,
  };
}

const byId = (r: ReturnType<typeof selfCheck>, id: string) => r.checks.find((c) => c.id === id);

describe("self-check — the good baseline passes everything (no vacuous green: broken fixtures below prove each fires)", () => {
  it("a consistent finished valuation → 0 blockers, 0 warns, all Class-A pass", () => {
    const r = selfCheck({ view: good() });
    expect(r.blockers).toBe(0);
    expect(r.warns).toBe(0);
    expect(r.checks.filter((c) => c.class === "A").every((c) => c.pass)).toBe(true);
  });

  it("the report is queryable data — {id,class,severity,pass,read,explain}", () => {
    const c = byId(selfCheck({ view: good() }), "A1-prob-range")!;
    expect(c).toMatchObject({ id: "A1-prob-range", class: "A", severity: "BLOCKER", pass: true });
    expect(typeof c.explain).toBe("string");
    expect(c.read).toBeTypeOf("object");
  });
});

describe("self-check — Class-A NON-VACUITY: each check fires on its deliberately-broken fixture", () => {
  it("A1 — a probability of 1.3 trips prob-range (and only it)", () => {
    const r = selfCheck({ view: good({ stageProbs: [1.3, 0.4] }) });
    expect(byId(r, "A1-prob-range")!.pass).toBe(false);
    expect(byId(r, "A2-prob-monotonic")!.pass).toBe(true);
    expect(byId(r, "A3-enpv-identity")!.pass).toBe(true);
    expect(r.blockers).toBeGreaterThanOrEqual(1);
  });

  it("A2 — a rising cumulative probability trips monotonicity", () => {
    const r = selfCheck({ view: good({ stageCumProbs: [0.2, 0.5] }) });
    expect(byId(r, "A2-prob-monotonic")!.pass).toBe(false);
    expect(byId(r, "A1-prob-range")!.pass).toBe(true);
  });

  it("A2 — pApproval > pAllTrials also trips monotonicity", () => {
    // raise pApproval alone would also desync eNPV; construct via cum only above. Here check summary rung.
    const v = good({ pApproval: 0.9, pAllTrialsSuccess: 0.2 });
    // neutralize A3 by matching eNPV to the tampered pApproval so ONLY A2 fires
    v.eNPVM = 0.9 * v.revenuePVM! - v.riskAdjCostM!;
    v.eROI = v.eNPVM / v.riskAdjCostM!;
    const r = selfCheck({ view: v });
    expect(byId(r, "A2-prob-monotonic")!.pass).toBe(false);
  });

  it("A3 — eNPV = +100 while its components compute −50 trips the identity", () => {
    // components: pApproval·revenuePVM − cost = 0.17·(150/0.17) − 200 = 150 − 200 = −50
    const r = selfCheck({ view: good({ eNPVM: 100, revenuePVM: 150 / 0.17, eROI: 100 / 200 }) });
    expect(byId(r, "A3-enpv-identity")!.pass).toBe(false);
  });

  it("A4 — LOE before launch, and negative duration, trip timeline ordering", () => {
    const r = selfCheck({ view: good({ loeYear: 2028, launchYear: 2030, totalDurationMonths: -6 }) });
    const a4 = byId(r, "A4-timeline-order")!;
    expect(a4.pass).toBe(false);
    expect(a4.explain).toMatch(/LOE|loeYear|duration/);
  });

  it("A5 — revenue booked before launch trips the revenue window (when a ramp is exposed)", () => {
    const r = selfCheck({ view: good({ revenueByYear: [{ year: 2028, revenueM: 100 }], launchYear: 2030 }) });
    expect(byId(r, "A5-revenue-window")!.pass).toBe(false);
  });

  it("A5 — does NOT run at a surface with no exposed ramp (folds into A4)", () => {
    // The engine surfaces revenuePVM (scalar), not a per-year ramp → A5 is absent, not failing.
    expect(byId(selfCheck({ view: good() }), "A5-revenue-window")).toBeUndefined();
  });

  it("A6 — NaN in a surfaced number and a 'TODO' placeholder string trip the bad-values sweep", () => {
    const r = selfCheck({ view: good({ surfacedNumbers: { leftover: NaN }, surfacedStrings: { note: "TODO" } }) });
    expect(byId(r, "A6-no-bad-values")!.pass).toBe(false);
  });

  it("A7 — a declared-change option byte-identical to Option A trips 'didn't re-derive'", () => {
    const baseTuple = { peakSalesM: 1000, devCostM: 200, ptrs: 0.17, eNPVM: 140 };
    const options: OptionView[] = [
      { id: "opt-a", isBaseline: true, declaresChange: false, tuple: baseTuple },
      { id: "opt-b", label: "Pivot", isBaseline: false, declaresChange: true, tuple: { ...baseTuple } }, // stuck
      { id: "opt-c", isBaseline: false, declaresChange: true, tuple: { peakSalesM: 3000, devCostM: 400, ptrs: 0.14, eNPVM: 20 } },
    ];
    const r = selfCheck({ options });
    expect(byId(r, "A7-option-rederived")!.pass).toBe(false);
    expect(byId(r, "A7-option-rederived")!.explain).toMatch(/opt-b|Pivot|did not take|re-derive/);
  });

  it("A7 — two identical peers with NO declared change is legitimate (NOT a blocker)", () => {
    const t = { peakSalesM: 1000, devCostM: 200, ptrs: 0.17, eNPVM: 140 };
    const options: OptionView[] = [
      { id: "opt-a", isBaseline: true, declaresChange: false, tuple: t },
      { id: "opt-b", isBaseline: false, declaresChange: false, tuple: { ...t } },
    ];
    expect(byId(selfCheck({ options }), "A7-option-rederived")!.pass).toBe(true);
  });
});

describe("self-check — A8 multi-indication aggregation (the pooled×one-P guard)", () => {
  // Two indications, each independently risked: lead P=0.30 × RevPV 800 − cost 50 = 190; second
  // P=0.15 × RevPV 400 − cost 50 = 10 → structural Σ = 200. The pooled×lead-P headline a naive
  // implementation would show is 0.30 × (800+400) − 100 = 260 — the exact bug A8 exists to catch.
  const components = [190, 10]; // per-indication STRUCTURAL contributions ($M)
  const structuralSum = 200;
  const pooledOneP = 260; // 0.30 × pooled 1200 − 100 shared cost

  it("headline == Σ structural contributions → A8 PASSES (0 blockers)", () => {
    const r = selfCheck({ view: good({ multiIndication: { headlineENPVM: structuralSum, componentRnpvsM: components } }) });
    expect(byId(r, "A8-multi-indication-aggregation")!.pass).toBe(true);
    expect(r.blockers).toBe(0);
  });

  it("headline == pooled revenue × the lead's single P → A8 FIRES (a blocker)", () => {
    const r = selfCheck({ view: good({ multiIndication: { headlineENPVM: pooledOneP, componentRnpvsM: components } }) });
    const a8 = byId(r, "A8-multi-indication-aggregation")!;
    expect(a8.pass).toBe(false);
    expect(a8.severity).toBe("BLOCKER");
    expect(a8.explain).toMatch(/pooled revenue|single P|Σ per-indication/);
    expect(r.blockers).toBeGreaterThanOrEqual(1);
  });

  it("A8 never false-fires on a CONDITIONAL aggregation (components are already P-weighted)", () => {
    // A conditional second indication's contribution is P-weighted (e.g. 0.30 × 10 = 3), so the
    // structure-resolved Σ is 190 + 3 = 193 — NOT the naive standalone Σ (200). A headline that
    // matches the resolved Σ passes; A8 targets the resolved aggregate, so no false positive.
    const cond = [190, 3];
    const r = selfCheck({ view: good({ multiIndication: { headlineENPVM: 193, componentRnpvsM: cond } }) });
    expect(byId(r, "A8-multi-indication-aggregation")!.pass).toBe(true);
  });

  it("a single-indication surface leaves A8 absent (nothing to aggregate)", () => {
    expect(byId(selfCheck({ view: good() }), "A8-multi-indication-aggregation")).toBeUndefined();
  });

  it("a non-finite component or headline trips A8 (cannot reconcile)", () => {
    const r = selfCheck({ view: good({ multiIndication: { headlineENPVM: NaN, componentRnpvsM: components } }) });
    expect(byId(r, "A8-multi-indication-aggregation")!.pass).toBe(false);
  });
});

describe("self-check — known-good FROZEN assets pass all Class-A", () => {
  // Built from the real frozen tripwire numbers (TTX 0.08986, tau 0.26751). eNPV identity holds
  // with the back-solved revenuePVM. A Class-A check that fired on a known-good asset would itself
  // be a bug — this asserts none do.
  const ttx = good({
    label: "TTX-MC138",
    pApproval: 0.08986,
    pAllTrialsSuccess: 0.10571,
    stageProbs: [0.18282, 0.57824],
    stageCumProbs: [0.18282, 0.10571],
    ptrs: 0.08986,
    ptrsCI: { lower: 0.06, upper: 0.13 },
    eNPVM: 28.9,
    revenuePVM: (28.9 + 19.51153) / 0.08986,
    riskAdjCostM: 19.51153,
    eROI: 1.48,
    launchYear: 2032,
    loeYear: 2045,
    impliedLaunchYear: 2032,
    totalDurationMonths: 72,
  });
  const tau = good({
    label: "BMS-986446 (tau)",
    pApproval: 0.26751,
    pAllTrialsSuccess: 0.31472,
    stageProbs: [0.6, 0.52453],
    stageCumProbs: [0.6, 0.31472],
    ptrs: 0.26751,
    ptrsCI: { lower: 0.2, upper: 0.34 },
    eNPVM: 500,
    revenuePVM: (500 + 60) / 0.26751,
    riskAdjCostM: 60,
    eROI: 8.33,
  });

  it("TTX passes every Class-A (0 blockers)", () => {
    const r = selfCheck({ view: ttx });
    expect(r.blockers).toBe(0);
    expect(r.checks.filter((c) => c.class === "A").every((c) => c.pass)).toBe(true);
  });

  it("tau passes every Class-A (0 blockers)", () => {
    const r = selfCheck({ view: tau });
    expect(r.blockers).toBe(0);
    expect(r.checks.filter((c) => c.class === "A").every((c) => c.pass)).toBe(true);
  });
});

describe("self-check — Class-B B1 is a PROVISIONAL WARN, never a blocker", () => {
  it("eROI above the provisional ceiling WARNs but does not block", () => {
    // internally CONSISTENT high-eROI fixture (A3 must still pass): eNPV = eROI·cost; revenuePVM back-solved
    const eROI = EROI_CEILING_PROVISIONAL + 15;
    const eNPVM = eROI * 200;
    const r = selfCheck({ view: good({ eROI, eNPVM, revenuePVM: (eNPVM + 200) / 0.17 }) });
    expect(byId(r, "A3-enpv-identity")!.pass).toBe(true); // the fixture is consistent; ONLY B1 fires
    const b1 = byId(r, "B1-eroi-ceiling")!;
    expect(b1.severity).toBe("WARN");
    expect(b1.provisional).toBe(true);
    expect(b1.pass).toBe(false);
    expect(r.blockers).toBe(0); // a WARN never counts as a blocker
    expect(r.warns).toBeGreaterThanOrEqual(1);
  });

  it("eROI within the ceiling passes B1", () => {
    expect(byId(selfCheck({ view: good({ eROI: 3 }) }), "B1-eroi-ceiling")!.pass).toBe(true);
  });
});

describe("self-check — B2 cost-basis divergence (the $3M-IPF gap A8 is blind to)", () => {
  it("FIRES when Σ per-indication dev cost ≫ the governing risk-adjusted plan cost (pre-fix: 850M vs 27M)", () => {
    const r = selfCheck({ view: { perIndicationDevCostSumM: 850, riskAdjCostM: 27 } });
    const b2 = byId(r, "B2-cost-basis-divergence")!;
    expect(b2.pass).toBe(false);
    expect(b2.severity).toBe("WARN");
    expect(b2.provisional).toBe(true);
    expect(b2.explain).toMatch(/different \(likely nominal\) cost basis|diverges/);
    expect(r.blockers).toBe(0); // WARN, never a blocker
    expect(r.warns).toBeGreaterThanOrEqual(1);
  });

  it("SILENT when reconciled (post-fix: 27M vs 27M — the strip routes rows to the risk-adjusted share)", () => {
    expect(byId(selfCheck({ view: { perIndicationDevCostSumM: 27, riskAdjCostM: 27 } }), "B2-cost-basis-divergence")!.pass).toBe(true);
  });

  it("absent when there's no per-indication dev-cost sum (single-indication / no split)", () => {
    expect(byId(selfCheck({ view: { riskAdjCostM: 27 } }), "B2-cost-basis-divergence")).toBeUndefined();
  });
});

describe("self-check — B3 per-indication rNPV sanity (revenue nearly eaten by cost)", () => {
  it("FIRES on IPF-like row (rNPV 3M ≪ 20% of P·RevPV 552M), not on the healthy row", () => {
    const r = selfCheck({ view: { multiIndication: {
      headlineENPVM: 89, componentRnpvsM: [3, 86], componentGrossM: [552, 385], labels: ["IPF", "Onc"],
    } } });
    const b3 = byId(r, "B3-per-indication-rnpv-sanity")!;
    expect(b3.pass).toBe(false);
    expect(b3.severity).toBe("WARN");
    expect(b3.provisional).toBe(true);
    expect(b3.explain).toMatch(/IPF/);
    expect(b3.explain).not.toMatch(/Onc/); // 86 > 20% of 385 → healthy, not flagged
    expect(r.blockers).toBe(0);
  });

  it("SILENT post-fix (rNPV ≈ risk-adjusted revenue: 538/372 vs gross 552/385)", () => {
    const r = selfCheck({ view: { multiIndication: {
      headlineENPVM: 910, componentRnpvsM: [538, 372], componentGrossM: [552, 385], labels: ["IPF", "Onc"],
    } } });
    expect(byId(r, "B3-per-indication-rnpv-sanity")!.pass).toBe(true);
  });

  it("no false positive on a CONDITIONAL indication (its P-weight is already in componentGrossM)", () => {
    // conditional dep: gross already P-weighted (e.g. 0.3 × 100 = 30), rnpv 24 → 24 > 20% of 30 → healthy
    const r = selfCheck({ view: { multiIndication: {
      headlineENPVM: 214, componentRnpvsM: [190, 24], componentGrossM: [220, 30], labels: ["Lead", "Dep"],
    } } });
    expect(byId(r, "B3-per-indication-rnpv-sanity")!.pass).toBe(true);
  });
});

describe("self-check — flag aggregation collects the engine's existing resolve-or-flag flags", () => {
  it("#14 unsourced / out-of-band niche provenance surface as flags", () => {
    const r = selfCheck({
      flags: {
        nicheProvenance: {
          wac: { value: 200000, comp: null, sourced: false, inBand: true },
          share: { value: 50, comp: "cited analog", sourced: true, inBand: false },
        },
      },
    });
    expect(r.flags.some((f) => f.id === "flag-wac-unsourced")).toBe(true);
    expect(r.flags.some((f) => f.id === "flag-share-out-of-band")).toBe(true);
    expect(r.warns).toBeGreaterThanOrEqual(2);
  });

  it("lifted engine booleans (reg held / enrichment hold / single-arm floor) surface as flags", () => {
    const r = selfCheck({ flags: { regUnconfirmed: true, enrichmentHeld: true, singleArmFloor: true } });
    expect(r.flags.map((f) => f.id)).toEqual(
      expect.arrayContaining(["flag-reg-unconfirmed", "flag-enrichment-held", "flag-single-arm-floor"]),
    );
  });
});

describe("self-check — STRUCTURAL: pure reader, never mutates its input", () => {
  it("selfCheck does not throw on a deeply-frozen input (no write-back)", () => {
    const view = Object.freeze(good()) as ValuationView;
    expect(() => selfCheck({ view })).not.toThrow();
  });

  it("selfCheck leaves the input values unchanged", () => {
    const view = good();
    const before = JSON.stringify(view);
    selfCheck({ view });
    expect(JSON.stringify(view)).toBe(before);
  });
});
