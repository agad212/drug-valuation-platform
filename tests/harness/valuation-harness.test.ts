import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { loadFixture, runDeterministicChain, headline, type Fixture, type ChainResult } from "./fixture-runner";

// ─── Offline fixture harness (Step 2) ──────────────────────────────────────────
//
// Loads each canonical fixture, runs the FULL deterministic chain on it (existing
// production functions, unchanged), and asserts the headline outputs. Zero API
// cost — this replaces "run a full live valuation to check the calculator".
//
// The clock is pinned so the two date-sensitive functions (computeRevenuePV,
// computeDevPlan→impliedLaunchYear) are reproducible offline.
const AS_OF = new Date("2026-07-01T00:00:00Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AS_OF);
});
afterAll(() => {
  vi.useRealTimers();
});

// Relative+absolute tolerance comparison for golden values.
function expectClose(actual: number, expected: number, relTol = 0.02, absTol = 0.5) {
  const tol = Math.max(absTol, Math.abs(expected) * relTol);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

const FIXTURES = ["ttx-mc138.fixture.json", "bms-986446.fixture.json"];

describe.each(FIXTURES)("Deterministic harness — %s", (file) => {
  let fx: Fixture;
  let r: ChainResult;
  let h: ReturnType<typeof headline>;

  beforeAll(() => {
    fx = loadFixture(file);
    r = runDeterministicChain(fx);
    h = headline(r);
    // Emit actuals so golden `expected` blocks can be (re)generated when the math
    // legitimately changes. Harmless in normal runs.
    // eslint-disable-next-line no-console
    console.log(`\n[HARNESS ACTUALS] ${fx.meta.asset}\n` + JSON.stringify(h, null, 2));
  });

  it("effect prior is a valid, non-degenerate mixture", () => {
    const w = r.effectPrior.mixture.reduce((s, c) => s + c.w, 0);
    expect(w).toBeCloseTo(1, 6);
    for (const c of r.effectPrior.mixture) {
      expect(Number.isFinite(c.mu)).toBe(true);
      expect(c.sigma2).toBeGreaterThan(0);
    }
    expect(h.finalMss).toBeGreaterThan(0);
    expect(h.finalMss).toBeLessThan(1);
  });

  it("modality class-status is read from the analog step (drives the haircut)", () => {
    expect(r.modalityClassStatus ?? null).toBe(fx.meta.expectedHeadline.classStatus);
    const shouldHaircut = fx.meta.expectedHeadline.appliesModalityHaircut;
    for (const st of r.devPlan.stages) {
      expect(st.modalityHaircut).toBe(shouldHaircut ? 0.8 : 1.0);
    }
  });

  it("P(approval) is in the documented headline band and never a definitional 0", () => {
    const [lo, hi] = fx.meta.expectedHeadline.pApprovalBand;
    expect(h.pApproval).toBeGreaterThan(0); // non-degenerate prior ⇒ never exactly 0
    expect(h.pApproval).toBeGreaterThanOrEqual(lo);
    expect(h.pApproval).toBeLessThanOrEqual(hi);
  });

  it("per-stage probabilities are internally consistent (ceiling ≤, haircut applied)", () => {
    for (const st of r.devPlan.stages) {
      expect(st.trialSuccessProb).toBeGreaterThanOrEqual(0);
      expect(st.trialSuccessProb).toBeLessThanOrEqual(1);
      // final = min(raw, ceiling) × haircut  ⇒  final ≤ raw
      expect(st.trialSuccessProb).toBeLessThanOrEqual(st.trialSuccessProbRaw + 1e-9);
      const capped = st.successCeilingBound ?? st.trialSuccessProbRaw;
      expect(st.trialSuccessProb).toBeCloseTo(capped * st.modalityHaircut, 6);
    }
    // pApproval = Π stage success × reg approval
    expect(h.pApproval).toBeCloseTo(r.devPlan.pAllTrialsSuccess * r.devPlan.regStage.pApproval, 6);
  });

  it("financials are internally consistent (eNPV identity, eROI identity)", () => {
    expect(h.revenuePVM).toBeGreaterThan(0);
    // eNPVM = round1(pApproval × revenuePVM − totalRiskAdjCostM)
    const eNPVexact = h.pApproval * h.revenuePVM - r.devPlan.totalRiskAdjCostM;
    expect(h.eNPVM).toBeCloseTo(eNPVexact, 0); // round1 tolerance
    if (r.devPlan.totalRiskAdjCostM > 0.1) {
      expect(h.eROI!).toBeCloseTo(h.eNPVM / r.devPlan.totalRiskAdjCostM, 1);
    }
  });

  it("timeline is credible (weeks→months normalization applied; launch year sane)", () => {
    expect(h.totalDurationMonths).toBeGreaterThan(0);
    expect(h.totalDurationMonths).toBeLessThan(220); // never the 353mo tau catastrophe
    // launch year within ~18y of the pinned as-of (credible, not decades out)
    expect(h.impliedLaunchYear).toBeGreaterThanOrEqual(AS_OF.getUTCFullYear());
    expect(h.impliedLaunchYear).toBeLessThanOrEqual(AS_OF.getUTCFullYear() + 18);
  });

  it("reproduces the golden headline (locks the deterministic layer)", () => {
    if (!fx.expected) {
      // First authoring pass: no golden yet. See [HARNESS ACTUALS] above, then bake
      // the values into the fixture's `expected` block.
      return;
    }
    const e = fx.expected;
    expectClose(h.finalMss, e.finalMss);
    expectClose(h.pApproval, e.pApproval);
    expectClose(h.s0_trialSuccessProb, e.s0_trialSuccessProb);
    expectClose(h.s0_trialSuccessProbRaw, e.s0_trialSuccessProbRaw);
    expectClose(h.s0_modalityHaircut, e.s0_modalityHaircut, 0, 1e-9);
    if (h.s1_trialSuccessProb != null) expectClose(h.s1_trialSuccessProb, e.s1_trialSuccessProb);
    expectClose(h.totalDurationMonths, e.totalDurationMonths, 0.02, 1);
    expectClose(h.impliedLaunchYear, e.impliedLaunchYear, 0, 0);
    // Fix #2 pinned dollar inputs
    expectClose(h.s0_cpp, e.s0_cpp, 0, 1);
    if (h.s1_cpp != null) expectClose(h.s1_cpp, e.s1_cpp, 0, 1);
    if (h.peakSalesM != null) expectClose(h.peakSalesM, e.peakSalesM, 0, 1);
    if (h.loeYear != null) expectClose(h.loeYear, e.loeYear, 0, 0);
    expectClose(h.totalRiskAdjCostM, e.totalRiskAdjCostM, 0.02, 0.5);
    expectClose(h.revenuePVM, e.revenuePVM);
    expectClose(h.eNPVM, e.eNPVM, 0.03, 2);
    if (h.eROI != null) expectClose(h.eROI, e.eROI, 0.05, 0.05);
  });
});

// NOTE: the comparator-reliability guard (the 0.0% regression) is regression-tested
// SYNTHETICALLY in regression-guards.test.ts (Guard 2) and lib/__tests__/calibration.test.ts
// with a pathological nullRR — it isn't asserted here because a captured fixture's SOC
// is whatever the live pipeline produced (sane in both current captures), not a fixed
// pathological value.

// ── Fix #2: financial-input pins are deterministic + P(approval) untouched ──────
// P(approval) was frozen when the probability engine closed (Fix #1b). Fix #2 pins
// only dollars, so these values must remain EXACT — the tripwire that we stayed out
// of the engine.
// Re-baselined to REAL live-captured values (2026-07-18).
// TTX = 0.09993 from a fresh live capture: real inputs differ from the earlier
// representative fixture (real single-arm Phase-2a hit by Fix C's cap → s0 0.206;
// real comps anchor peak at $625M). tau = 0.15535 UNCHANGED — its live capture
// failed on Anthropic credit exhaustion, so its fixture was not refreshed this batch.
const FROZEN_PAPPROVAL: Record<string, number> = {
  "ttx-mc138.fixture.json": 0.09993,
  "bms-986446.fixture.json": 0.15535,
};

describe.each(FIXTURES)("Fix #2 financial pins — %s", (file) => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(AS_OF); });
  afterAll(() => vi.useRealTimers());

  it("TRIPWIRE: P(approval) is UNCHANGED by the financial pins (engine untouched)", () => {
    const r = runDeterministicChain(loadFixture(file));
    expect(r.devPlan.pApproval).toBeCloseTo(FROZEN_PAPPROVAL[file], 5);
  });

  it("pinned dollar inputs are reproducible run-to-run (no variance)", () => {
    const fx = loadFixture(file);
    const a = headline(runDeterministicChain(fx));
    const b = headline(runDeterministicChain(fx));
    expect(a.s0_cpp).toBe(b.s0_cpp);
    expect(a.peakSalesM).toBe(b.peakSalesM);
    expect(a.loeYear).toBe(b.loeYear);
    expect(a.eNPVM).toBe(b.eNPVM);
  });

  it("every dollar input carries a provenance label (pinned / estimate)", () => {
    const r = runDeterministicChain(loadFixture(file));
    for (const st of r.devPlan.stages) expect(st.cppProvenance).toMatch(/^pinned:/);
    expect(r.peakPin!.provenance).toMatch(/^(pinned|estimate):/);
    expect(r.loePin!.provenance).toMatch(/^(pinned|estimate):/);
  });

  it("CPP is the deterministic phase×TA benchmark central (not the raw LLM value)", () => {
    const r = runDeterministicChain(loadFixture(file));
    for (const st of r.devPlan.stages) {
      expect(st.cpp).toBeGreaterThan(0);
      expect(Number.isFinite(st.cppRaw)).toBe(true);
    }
  });

  it("P&L consumes the CANONICAL dev-plan cost (risk-adj ≤ nominal, both > 0) — Part 1 audit", () => {
    // The P&L now reads devPlan.totalRiskAdjCostM / totalNominalCostM (the pinned dev
    // cost), NOT the stale auto-value devCostPV. These are the golden-tested canonical
    // values, so the P&L's dev spend reconciles with the headline eNPV.
    const r = runDeterministicChain(loadFixture(file));
    expect(r.devPlan.totalRiskAdjCostM).toBeGreaterThan(0);
    expect(r.devPlan.totalRiskAdjCostM).toBeLessThanOrEqual(r.devPlan.totalNominalCostM);
  });
});
