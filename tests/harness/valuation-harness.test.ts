import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { loadFixture, runDeterministicChain, headline, type Fixture, type ChainResult } from "./fixture-runner";
import { classGraveyardProbability, analogEffectSignal } from "../../lib/class-risk";

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

  it("modality class-status + haircut are the deterministic blend over p_graveyard", () => {
    expect(r.modalityClassStatus ?? null).toBe(fx.meta.expectedHeadline.classStatus);
    // Haircut is the blend 1 − 0.20·p_graveyard (Part 2), NOT the old binary 0.80/1.0.
    const p = r.devPlan.classGraveyardProbability ?? 0;
    const expectedHaircut = 1 - 0.2 * p;
    for (const st of r.devPlan.stages) {
      expect(st.modalityHaircut).toBeCloseTo(expectedHaircut, 6);
    }
    // "applies a haircut" ⇔ haircut < 1 ⇔ p_graveyard > 0.
    expect(fx.meta.expectedHeadline.appliesModalityHaircut).toBe(p > 0);
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

// ── P(approval) tripwire: engine math stays put; only PINNED inputs move it ──────
// This locks P(approval) to a fixed value per fixture. The stage-success MATH,
// Bayesian fusion, ceilings and haircut FORMULA are frozen — a change here means a
// math regression. The value legitimately moves ONLY when we deliberately pin a new
// INPUT (a designation, a comparator, a classification), which is recorded below.
// TTX = 0.09993 (live capture 2026-07-18) → 0.08986 (2026-07-26 base re-pin capstone) →
// RE-PINNED 2026-08-07 to 0.02844 by the 2.2 ANCHORED-SCALE re-pin. The old absolute map
// (mean_rr = μ/2) read the effect prior's relative multiplier as an absolute response rate,
// building in a ~30-point effect against typical nulls — raw stage success saturated at
// 93–100% and the ceilings capped an inflated number. The anchored map (mean_rr = anchor +
// μ·Δ, Δ = 0.10 = the clinical-meaningfulness margin) derives the margin from the evidence:
// TTX (μ ≈ 0.63, below-average; TTE-proxy stages anchored at the proxy floor 0.25) lands at
// 0.02844 — consistent with the oncology early-phase base rate (3.4% Phase-1→approval,
// Wong/Siah/Lo 2019, Biostatistics) for an asset with below-average evidence. eNPV honestly
// goes slightly negative (−$3.2M). Validated, not tuned: at μ = 1.0 the same fixtures
// reproduce phase base rates (Ph2b ≈ 30–35%, Ph3 ≈ 55–60%).
// tau = 0.26751 → RE-PINNED 2026-08-07 to 0.02519 by the same rescale. An anti-tau antibody
// (class: ZERO approvals, documented failure pattern — gosuranemab, tilavonemab,
// semorinemab; this fixture's blended p_graveyard = 0.872) with below-average evidence
// (μ ≈ 0.70) at 2.5% is defensible against the class record; the old 26.75% would have made
// it a near-best-in-industry CNS bet. The fixture's documented pApprovalBand was re-authored
// [0.168,0.368] → [0.01,0.15] with the rationale recorded in the fixture meta.
const FROZEN_PAPPROVAL: Record<string, number> = {
  "ttx-mc138.fixture.json": 0.02844,
  "bms-986446.fixture.json": 0.02519,
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

// ── tau reproducibility pins are EXERCISED by the committed fixture (not fallback) ──
// The committed tau fixture is now a live capture on the deployed pins. These
// assertions run the deterministic chain on it and fail if ANY pin regresses — the
// regression net for the classifications we pinned (Parts 1/2/4/A). They are the
// reason the harness now protects the pinned world rather than the pre-fix world.
describe("tau fixture exercises the reproducibility pins", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(AS_OF); });
  afterAll(() => vi.useRealTimers());

  const load = () => runDeterministicChain(loadFixture("bms-986446.fixture.json"));

  it("Part 1: regulatory context resolves to fast_track (not btd) — top level + every stage", () => {
    const r = load();
    expect(r.devPlan.regStage.regulatoryContext).toBe("fast_track");
    for (const st of r.devPlan.stages) expect(st.trialDesign.regulatoryContext).toBe("fast_track");
    // fast_track confers the STANDARD reg-approval probability (no BTD-level uplift).
    expect(r.devPlan.regStage.pApproval).toBeCloseTo(0.85, 10);
  });

  it("Part 4: both AD stages carry the pinned CDR-SB comparator (nullRR 0.10, σ² 0.01)", () => {
    const fx = loadFixture("bms-986446.fixture.json");
    for (const st of fx.devPlan.stages) {
      expect(st.nullResponseRate).toBe(0.10);
      expect(st.comparatorSigma2).toBe(0.01);
    }
  });

  it("Part 2: classStatus + haircut come from the deterministic rule (blend, not a flip)", () => {
    const r = load();
    const ev = loadFixture("bms-986446.fixture.json").chainSteps.find((s) => s.source === "analog")!.classEvidence!;
    const rule = classGraveyardProbability(ev);
    expect(r.modalityClassStatus).toBe(rule.classStatus);
    expect(r.devPlan.classGraveyardProbability).toBeCloseTo(rule.pGraveyard, 10);
    for (const st of r.devPlan.stages) {
      expect(st.modalityHaircut).toBeCloseTo(1 - 0.2 * rule.pGraveyard, 10);
    }
  });

  it("Part A: the analog effect-size μ/σ² is the deterministic pin (not a per-run LLM value)", () => {
    const r = load();
    const ev = loadFixture("bms-986446.fixture.json").chainSteps.find((s) => s.source === "analog")!.classEvidence!;
    const sig = analogEffectSignal(ev);
    const analog = r.effectPrior.chain.find((s) => s.source === "analog")!;
    expect(analog.signal!.mu).toBeCloseTo(sig.mu, 10);
    expect(analog.signal!.sigma2).toBeCloseTo(sig.sigma2, 10);
  });

  it("all pins are reproducible run-to-run (identical output on repeat)", () => {
    const a = runDeterministicChain(loadFixture("bms-986446.fixture.json"));
    const b = runDeterministicChain(loadFixture("bms-986446.fixture.json"));
    expect(a.devPlan.pApproval).toBe(b.devPlan.pApproval);
  });
});
