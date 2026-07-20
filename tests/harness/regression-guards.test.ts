import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { loadFixture, runDeterministicChain } from "./fixture-runner";
import { computeDevPlan, type DevStageInput } from "../../lib/dev-plan";
import { computeStageRR, computeStageSuccess } from "../../lib/bayesian-rr";
import { mixtureFromMssVariance } from "../../lib/effect-prior";
import { pinCostPerPatient, anchorPeakSales, computeLoeYear } from "../../lib/financial-pins";
import type { TrialDesignInputs } from "../../lib/ptrs-trial";

// ─── Regression guards (Step 3) ────────────────────────────────────────────────
//
// Explicit, offline guards for every bug the deterministic layer has hit. Each is
// a function of fixed inputs — no LLM, no API. If any of these ever flips, a math
// change silently reintroduced a known failure.

const AS_OF = new Date("2026-07-01T00:00:00Z");
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(AS_OF); });
afterAll(() => vi.useRealTimers());

const design = (o: Partial<TrialDesignInputs> = {}): TrialDesignInputs => ({
  n: 300, endpointType: "surrogate", designType: "rct",
  populationType: "broad", placeboResponse: "low", regulatoryContext: "standard", ...o,
});
const stage = (o: Partial<DevStageInput>): DevStageInput => ({
  id: "s", name: "st", phase: "Phase 2", n: o.n ?? 300, cpp: 200000,
  trialDesign: o.trialDesign ?? design({ n: o.n ?? 300 }),
  isCurrentTrial: o.isCurrentTrial ?? true,
  enrollmentRatePerMonth: o.enrollmentRatePerMonth ?? 15,
  treatmentObsMonths: o.treatmentObsMonths ?? 12,
  startupCushionMonths: o.startupCushionMonths ?? 6,
  enrollmentComplete: o.enrollmentComplete,
  isTimeToEvent: o.isTimeToEvent ?? false,
  nullResponseRate: o.nullResponseRate ?? 0.2,
  ...o,
});
const plan = (stages: DevStageInput[], mss = 0.5, modalityClassStatus?: any) =>
  computeDevPlan(mixtureFromMssVariance(mss, 0.15), 0.1,
    { stages, regulatoryContext: "standard", modalityClassStatus }, 1000);

// 1 ── TIMELINE UNITS: week-counts become credible months, never verbatim ────────
describe("Guard 1 — timeline weeks→months normalization", () => {
  it("a 76-week obs reads ~18mo (not 76) and a 96-week reads ~22mo", () => {
    const p76 = plan([stage({ treatmentObsMonths: 76 })]).stages[0];
    expect(p76.treatmentObsWasWeeks).toBe(true);
    expect(p76.treatmentObsMonths).toBeGreaterThan(15);
    expect(p76.treatmentObsMonths).toBeLessThan(20);
    const p96 = plan([stage({ treatmentObsMonths: 96 })]).stages[0];
    expect(p96.treatmentObsMonths).toBeCloseTo(96 / 4.345, 1);
  });

  it("captured fixtures have credible timelines; every obs duration is within the month ceiling", () => {
    // NOTE: the live dev-plan LLM now emits durations in months, so a captured fixture
    // may show no week-conversion — that's the prompt fix working. The synthetic test
    // above is the direct weeks→months guard; here we assert the OUTPUT is always credible
    // (never the 353-month tau catastrophe; every obs component ≤ the 36-month ceiling).
    for (const f of ["ttx-mc138.fixture.json", "bms-986446.fixture.json"]) {
      const { devPlan } = runDeterministicChain(loadFixture(f));
      expect(devPlan.totalDurationMonths).toBeGreaterThan(0);
      expect(devPlan.totalDurationMonths).toBeLessThan(200); // never the 353mo catastrophe
      expect(devPlan.impliedLaunchYear).toBeLessThanOrEqual(AS_OF.getUTCFullYear() + 18);
      for (const st of devPlan.stages) expect(st.treatmentObsMonths).toBeLessThanOrEqual(36);
    }
  });

  it("a fully-enrolled current trial uses months-to-completion, not projected enrollment", () => {
    // Clock pinned to 2026-07-01 → a Nov-2027 readout is ~16 months out. The remaining
    // duration must be the time to that KNOWN completion date, NOT the projected
    // enroll+obs+startup (which would over-count an already-running, fully-enrolled trial).
    const withDate = plan([stage({
      isCurrentTrial: true, enrollmentComplete: true, completionDate: "2027-11-30",
      n: 300, enrollmentRatePerMonth: 2, treatmentObsMonths: 24, startupCushionMonths: 10,
    })]).stages[0];
    expect(withDate.durationFromCompletion).toBe(true);
    expect(withDate.durationMonths).toBe(16); // months to Nov 2027, not 24+ projected
    // Stale/far-future completion clamped to the credible max; a past date floored.
    expect(plan([stage({ isCurrentTrial: true, enrollmentComplete: true, completionDate: "2099-01-01" })]).stages[0].durationMonths).toBe(36);
    expect(plan([stage({ isCurrentTrial: true, enrollmentComplete: true, completionDate: "2020-01-01" })]).stages[0].durationMonths).toBe(3);
    // No completion date → falls back to enroll(0, fully enrolled) + obs + startup.
    const noDate = plan([stage({ isCurrentTrial: true, enrollmentComplete: true, treatmentObsMonths: 18, startupCushionMonths: 6 })]).stages[0];
    expect(noDate.durationFromCompletion).toBe(false);
    expect(noDate.durationMonths).toBeCloseTo(24, 6);
  });
});

// 2 ── NON-DEGENERATE PRIOR ≠ 0%: full path incl. comparator derivation ──────────
describe("Guard 2 — a non-degenerate prior can never yield 0.0% stage success", () => {
  const rr = { designType: "rct" as const, endpointType: "surrogate" as const,
    populationType: "broad" as const, regulatoryContext: "standard" as const };

  it("a pathological SOC above the prior mean is discarded, not zeroed (the tau incident)", () => {
    const r = computeStageRR(mixtureFromMssVariance(0.5, 0.12), 300, 0.80, rr, false);
    expect(r.comparatorUnreliable).toBe(true);
    expect(r.trialSuccessProb).toBeGreaterThan(0.05);
    expect(r.bandsBefore.belowThreshold).toBeLessThan(0.999);
  });

  it("holds through the full computeDevPlan path on both captured fixtures (no stage zeroed)", () => {
    for (const f of ["ttx-mc138.fixture.json", "bms-986446.fixture.json"]) {
      const { devPlan } = runDeterministicChain(loadFixture(f));
      expect(devPlan.pApproval).toBeGreaterThan(0);
      for (const st of devPlan.stages) expect(st.trialSuccessProb).toBeGreaterThan(0);
    }
  });
});

// 3 ── CEILINGS BIND: detection ≠ certainty; raw preserved ───────────────────────
describe("Guard 3 — base-rate ceilings cap saturating stages (raw preserved)", () => {
  const tight = design({ n: 600, designType: "rct", populationType: "biomarker_selected",
    placeboResponse: "low", regulatoryContext: "btd" });
  it("a tight-comparator Phase 2 caps at ≤0.90 general ceiling", () => {
    const st = plan([stage({ n: 600, phase: "Phase 2", trialDesign: tight,
      nullResponseRate: 0.20, comparatorSigma2: 0.004 })], 0.75).stages[0];
    expect(st.trialSuccessProbRaw).toBeGreaterThan(0.9); // raw WOULD saturate
    expect(st.trialSuccessProb).toBeLessThanOrEqual(0.90 + 1e-9);
    expect(st.successCeilingBound).toBe(0.90);
  });
  it("a Phase 3 (confirmatory) caps at the lower ≤0.80 late-phase ceiling", () => {
    const st = plan([stage({ n: 600, phase: "Phase 3", trialDesign: tight,
      nullResponseRate: 0.20, comparatorSigma2: 0.004 })], 0.75).stages[0];
    expect(st.trialSuccessProb).toBeLessThanOrEqual(0.80 + 1e-9);
    expect(st.successCeilingBound).toBe(0.80);
  });
});

// 4 ── HAIRCUT CONDITIONING: graveyard ×0.80, mixed/precedent ×1.0 ───────────────
describe("Guard 4 — modality haircut is class-conditioned", () => {
  it("each captured fixture's haircut matches its analog classStatus (graveyard→0.80, else 1.0)", () => {
    for (const f of ["ttx-mc138.fixture.json", "bms-986446.fixture.json"]) {
      const { modalityClassStatus, devPlan } = runDeterministicChain(loadFixture(f));
      const expectedHaircut = modalityClassStatus === "graveyard" ? 0.8 : 1.0;
      for (const st of devPlan.stages) expect(st.modalityHaircut).toBe(expectedHaircut);
    }
  });
  it("class-conditioning holds synthetically: graveyard→0.80, mixed/precedent/none→1.0", () => {
    const mk = (cls: any) => plan([stage({ n: 200, phase: "Phase 2", nullResponseRate: 0.15 })], 0.5, cls).stages[0];
    expect(mk("graveyard").modalityHaircut).toBe(0.8);
    for (const cls of ["mixed", "precedent", undefined] as const) {
      expect(mk(cls).modalityHaircut).toBe(1.0);
    }
  });
});

// 5 ── DOUBLE-COUNT SEPARATION: the analog effect-prior pull and the stage haircut
//     act on DIFFERENT quantities — the haircut multiplies the (capped) integral;
//     it does NOT change the raw integral. So graveyard vs none leaves the raw
//     identical and scales only the final by exactly 0.80.
describe("Guard 5 — effect-prior pull and stage haircut are multiplicatively independent", () => {
  it("classStatus changes only the haircut factor, never the raw stage integral", () => {
    const stages = () => [stage({ n: 200, phase: "Phase 2", nullResponseRate: 0.15 })];
    const graveyard = plan(stages(), 0.5, "graveyard").stages[0];
    const none = plan(stages(), 0.5, undefined).stages[0];
    // raw (pre-ceiling, pre-haircut) integral is identical — the prior did the same work
    expect(graveyard.trialSuccessProbRaw).toBeCloseTo(none.trialSuccessProbRaw, 9);
    // final differs by EXACTLY the haircut factor
    expect(graveyard.modalityHaircut).toBe(0.8);
    expect(none.modalityHaircut).toBe(1.0);
    const cappedG = graveyard.successCeilingBound ?? graveyard.trialSuccessProbRaw;
    const cappedN = none.successCeilingBound ?? none.trialSuccessProbRaw;
    expect(cappedG).toBeCloseTo(cappedN, 9); // same ceiling behavior
    expect(graveyard.trialSuccessProb).toBeCloseTo(none.trialSuccessProb * 0.8, 9);
  });
});

// 6 ── WHAT-IF DIRECTIONS: smaller n lowers; harder bar lowers (never inverts) ────
describe("Guard 6 — counterfactual directions are correct", () => {
  const rr = { designType: "rct" as const, endpointType: "surrogate" as const,
    populationType: "broad" as const, regulatoryContext: "standard" as const };
  const g = computeStageRR(mixtureFromMssVariance(0.4, 0.15), 160, 0.20, rr, false).priorGrid;

  it("halving n lowers P(success)", () => {
    expect(computeStageSuccess(g, 80, 0.20, rr)).toBeLessThanOrEqual(computeStageSuccess(g, 160, 0.20, rr));
  });
  it("a harder bar (higher null RR) lowers P(success) — never raises it", () => {
    const base = computeStageSuccess(g, 160, 0.20, rr);
    expect(computeStageSuccess(g, 160, 0.35, rr)).toBeLessThanOrEqual(base + 1e-9);
  });
  it("the shipped 'harder bar' counterfactual moves down, not up (the inversion we fixed)", () => {
    const r = computeStageRR(mixtureFromMssVariance(0.4, 0.15), 160, 0.20, rr, false);
    const harder = r.counterfactuals.find((c) => /harder bar/i.test(c.label));
    if (harder) expect(harder.pSuccess).toBeLessThanOrEqual(r.trialSuccessProb + 1e-9);
    const halved = r.counterfactuals.find((c) => /halved/i.test(c.label));
    if (halved) expect(halved.pSuccess).toBeLessThanOrEqual(r.trialSuccessProb + 1e-9);
  });

  // Fix C: single-arm is NEVER more conclusive than an equivalent RCT (the earlier
  // non-monotonicity is corrected by capping single-arm power at the RCT-equivalent).
  it("single-arm ≤ RCT at equal effect/n (registration credibility) — Fix C", () => {
    const rctD = { ...rr, designType: "rct" as const };
    const saD = { ...rr, designType: "single_arm" as const };
    for (const [mss, n, nullR] of [[0.30, 120, 0.15], [0.45, 200, 0.20], [0.6, 300, 0.25]] as const) {
      const grid = computeStageRR(mixtureFromMssVariance(mss, 0.15), n, nullR, rctD, false).priorGrid;
      const rctP = computeStageSuccess(grid, n, nullR, rctD);        // concurrent control
      const saP = computeStageSuccess(grid, n, nullR, saD, 0.02);    // historical control
      expect(saP).toBeLessThanOrEqual(rctP + 1e-9);
    }
  });

  it("the 'single-arm instead of RCT' what-if now moves DOWN (Fix C corrected the inversion)", () => {
    const r = computeStageRR(mixtureFromMssVariance(0.45, 0.15), 200, 0.20, rr, false); // RCT base
    const sa = r.counterfactuals.find((c) => /single-arm instead of RCT/i.test(c.label));
    if (sa) expect(sa.pSuccess).toBeLessThanOrEqual(r.trialSuccessProb + 1e-9);
  });

  it("ALL fixture what-ifs are directionally correct on both captured fixtures", () => {
    for (const f of ["ttx-mc138.fixture.json", "bms-986446.fixture.json"]) {
      const { devPlan } = runDeterministicChain(loadFixture(f));
      for (const st of devPlan.stages) {
        const base = st.trialSuccessProbRaw; // counterfactuals compare to the raw integral
        for (const cf of st.counterfactuals ?? []) {
          // Harder / less-credible ablations (incl. single-arm, now corrected) ≤ base.
          if (/harder bar|halved|single-arm instead of RCT|broad population/i.test(cf.label)) {
            expect(cf.pSuccess).toBeLessThanOrEqual(base + 1e-9);
          }
          if (/biomarker-selected population/i.test(cf.label)) {
            expect(cf.pSuccess).toBeGreaterThanOrEqual(base - 1e-9); // selection helps → higher
          }
        }
      }
    }
  });
});

// 7 ── FINANCIAL PINS (Fix #2): out-of-band LLM $ values are anchored/clamped ─────
describe("Guard 7 — financial inputs are pinned/anchored, not passed through raw", () => {
  it("CPP: an absurd LLM cost-per-patient is replaced by the phase×TA benchmark central", () => {
    const wild = pinCostPerPatient("Phase 2", "oncology", { llmCpp: 900_000 });   // absurd
    const sane = pinCostPerPatient("Phase 2", "oncology", { llmCpp: 130_000 });   // in band
    expect(wild.cpp).toBe(sane.cpp);         // same pinned central regardless of the LLM number
    expect(wild.clamped).toBe(true);         // flagged out-of-band
    expect(wild.raw).toBe(900_000);          // raw preserved for provenance
    expect(wild.provenance).toMatch(/pinned:/);
    // rare/orphan designation uses the premium band
    const rare = pinCostPerPatient("Phase 2", "oncology", { regulatoryContext: "orphan", llmCpp: 130_000 });
    expect(rare.cpp).toBeGreaterThan(sane.cpp);
  });

  it("PEAK SALES: base is anchored to the comp median, deterministic; a swinging LLM peak is ignored", () => {
    const comps = [
      { drug: "A", peakSalesM: 200 }, { drug: "B", peakSalesM: 400 },
      { drug: "Ceiling", peakSalesM: 20000, relation: "ceiling" as const },
    ];
    const a = anchorPeakSales(comps, { rawLlmPeakM: 185 });
    const b = anchorPeakSales(comps, { rawLlmPeakM: 750 });   // wildly different LLM guess
    expect(a.baseM).toBe(b.baseM);           // anchored to comps, not the LLM value
    expect(a.baseM).toBe(300);               // median of [200, 400]
    expect(a.provenance).toMatch(/^pinned:/);
    // no comps → honest labeled fallback
    const none = anchorPeakSales([], { rawLlmPeakM: 500 });
    expect(none.provenance).toMatch(/^estimate:/);
  });

  it("LOE: rule-based estimate is labeled and never a fabricated patent; real patent data governs when later", () => {
    const rule = computeLoeYear({ launchYear: 2035, modality: "small_molecule" });
    expect(rule.loeYear).toBe(2040);         // 2035 + NCE 5y
    expect(rule.isEstimate).toBe(true);
    expect(rule.provenance).toMatch(/rule-based, NOT a patent date/);
    const biologicOrphan = computeLoeYear({ launchYear: 2035, modality: "biologic", regulatoryContext: "orphan" });
    expect(biologicOrphan.loeYear).toBe(2047); // max(12y biologic, 7y orphan) = 12y
    const patent = computeLoeYear({ launchYear: 2035, modality: "small_molecule", patentLoeYear: 2049 });
    expect(patent.loeYear).toBe(2049);
    expect(patent.basis).toBe("patent");
  });

  it("HARD INVARIANT: LOE always exceeds launch; window ≥ the regulatory term (no LOE-before-launch)", () => {
    // A patent date BEFORE launch is structurally impossible → ignored, floored to
    // launch + regulatory term. (This is the tau-class window-collapse guard.)
    const patentBeforeLaunch = computeLoeYear({ launchYear: 2035, modality: "biologic", patentLoeYear: 2033 });
    expect(patentBeforeLaunch.loeYear).toBe(2047);            // launch + 12y BPCIA, patent ignored
    expect(patentBeforeLaunch.loeYear).toBeGreaterThan(2035);
    // Window ≥ the modality's regulatory term across launches — never negative/zero.
    const cases: [number, "biologic" | "small_molecule" | "oligonucleotide", number][] = [
      [2035, "biologic", 12], [2040, "small_molecule", 5], [2030, "oligonucleotide", 5], [2050, "biologic", 12],
    ];
    for (const [launch, mod, minTerm] of cases) {
      const r = computeLoeYear({ launchYear: launch, modality: mod });
      expect(r.loeYear).toBeGreaterThan(launch);               // invariant
      expect(r.loeYear - launch).toBeGreaterThanOrEqual(minTerm); // window ≥ term
    }
  });

  it("orphan 7y term applies ONLY when confirmed for the base-case indication (honors Fix B)", () => {
    // small-molecule + orphan context but NOT confirmed → base 5y term (no orphan extension)
    const notConfirmed = computeLoeYear({ launchYear: 2035, modality: "small_molecule", regulatoryContext: "orphan" });
    expect(notConfirmed.loeYear).toBe(2040);                  // launch + 5y NCE; orphan NOT applied
    // confirmed → max(5y NCE, 7y orphan) = 7y
    const confirmed = computeLoeYear({ launchYear: 2035, modality: "small_molecule", regulatoryContext: "orphan", orphanConfirmed: true });
    expect(confirmed.loeYear).toBe(2042);                     // launch + 7y orphan
    // biologic floor (12y) dominates orphan either way — tau's case, orphan-independent
    const biologic = computeLoeYear({ launchYear: 2035, modality: "biologic", regulatoryContext: "btd", orphanConfirmed: false });
    expect(biologic.loeYear).toBe(2047);
  });
});

// 8 ── FIX B: orphan benefit gates on indication-confirmation (deliberate P-move) ─
describe("Guard 8 — orphan benefit applies only when confirmed for the base-case indication", () => {
  const orphanStage = () => stage({
    n: 200, phase: "Phase 2", nullResponseRate: 0.15,
    trialDesign: design({ n: 200, regulatoryContext: "orphan" }),
  });
  const planOrphan = (confirmed: boolean) =>
    computeDevPlan(mixtureFromMssVariance(0.5, 0.15), 0.1,
      { stages: [orphanStage()], regulatoryContext: "orphan", orphanConfirmedForIndication: confirmed }, 1000);

  it("confirmed orphan → benefits applied → HIGHER P than the gated-off (unearned) case", () => {
    const confirmed = planOrphan(true);
    const gated = planOrphan(false);
    expect(confirmed.pApproval).toBeGreaterThan(gated.pApproval); // easier bar + reg uplift only when earned
    expect(confirmed.orphanGatedOff).toBe(false);
    expect(gated.orphanGatedOff).toBe(true);
  });

  it("mismatched orphan (gated off) is IDENTICAL to running the standard context", () => {
    const gated = planOrphan(false);
    const asStandard = computeDevPlan(mixtureFromMssVariance(0.5, 0.15), 0.1,
      { stages: [stage({ n: 200, phase: "Phase 2", nullResponseRate: 0.15, trialDesign: design({ n: 200, regulatoryContext: "standard" }) })],
        regulatoryContext: "standard" }, 1000);
    expect(gated.pApproval).toBeCloseTo(asStandard.pApproval, 9);
  });

  it("a non-orphan context is never gated (orphanGatedOff false)", () => {
    const p = plan([stage({ n: 200, phase: "Phase 2", nullResponseRate: 0.15 })], 0.5);
    expect(p.orphanGatedOff).toBeFalsy();
  });
});
