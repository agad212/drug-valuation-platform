import { describe, it, expect } from "vitest";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import { isEnrollmentComplete } from "../ctgov";
import type { TrialDesignInputs } from "../ptrs-trial";

// Financial-layer fix #1 — timeline / duration units. These lock the two failure
// modes that pushed tau's launch to 2055: weeks dropped into month fields, and
// non-credible enrollment projections. Durations feed the launch timeline ONLY —
// the last test proves no probability value moves when they change.

const design: TrialDesignInputs = {
  n: 300, endpointType: "surrogate", designType: "rct",
  populationType: "broad", placeboResponse: "low", regulatoryContext: "standard",
};

function stage(o: Partial<DevStageInput>): DevStageInput {
  const n = o.n ?? 300;
  return {
    id: o.id ?? "s", name: o.name ?? "st", phase: o.phase ?? "Phase 2",
    n, cpp: o.cpp ?? 200000,
    trialDesign: o.trialDesign ?? { ...design, n },
    isCurrentTrial: o.isCurrentTrial ?? false,
    enrollmentRatePerMonth: o.enrollmentRatePerMonth ?? 15,
    treatmentObsMonths: o.treatmentObsMonths ?? 12,
    startupCushionMonths: o.startupCushionMonths ?? 6,
    enrollmentComplete: o.enrollmentComplete,
    isTimeToEvent: o.isTimeToEvent ?? false,
    nullResponseRate: o.nullResponseRate ?? 0.2,
  };
}

function plan(stages: DevStageInput[]) {
  return computeDevPlan(mixtureFromMssVariance(0.5, 0.15), 0.15,
    { stages, regulatoryContext: "standard" }, 1000);
}

describe("Fix #1 — weeks→months unit normalization", () => {
  it("(i) a 76-week observation period reads ~18 months, not 76", () => {
    const st = plan([stage({ isCurrentTrial: true, treatmentObsMonths: 76 })]).stages[0];
    expect(st.treatmentObsWasWeeks).toBe(true);
    expect(st.treatmentObsMonths).toBeGreaterThan(15);
    expect(st.treatmentObsMonths).toBeLessThan(20); // 76 / 4.345 ≈ 17.5
    expect(st.treatmentObsMonthsRaw).toBe(76);
  });

  it("a 96-week extension reads ~22 months", () => {
    const st = plan([stage({ isCurrentTrial: true, treatmentObsMonths: 96 })]).stages[0];
    expect(st.treatmentObsWasWeeks).toBe(true);
    expect(st.treatmentObsMonths).toBeCloseTo(96 / 4.345, 1); // ≈ 22.1
  });

  it("a genuinely long-in-months value (≤52) is NOT treated as weeks", () => {
    const st = plan([stage({ isCurrentTrial: true, treatmentObsMonths: 30 })]).stages[0];
    expect(st.treatmentObsWasWeeks).toBe(false);
    expect(st.treatmentObsMonths).toBe(30); // ≤ ceiling, unchanged
  });
});

describe("Fix #1 — enrollment sanity bounds", () => {
  it("(ii) a fully-enrolled current trial contributes ~0 remaining enrollment", () => {
    // Raw would be 372 / 6 ≈ 62 months of accrual; fully enrolled ⇒ elapsed ⇒ 0.
    const st = plan([stage({
      isCurrentTrial: true, enrollmentComplete: true, n: 372, enrollmentRatePerMonth: 6,
    })]).stages[0];
    expect(st.enrollmentMonths).toBe(0);
    expect(st.enrollmentComplete).toBe(true);
    expect(st.enrollmentMonthsRaw).toBeGreaterThan(55); // ~62, preserved for display
  });

  it("(iii) an absurd future-stage enrollment clamps to the phase ceiling", () => {
    // Phase 3, 280 / 2.8 = 100 months of accrual → clamp to the Phase-3 ceiling (48).
    const p = plan([
      stage({ id: "s1", isCurrentTrial: true, phase: "Phase 2" }),
      stage({ id: "s2", isCurrentTrial: false, phase: "Phase 3", n: 280, enrollmentRatePerMonth: 2.8,
        trialDesign: { ...design, n: 280 } }),
    ]);
    const ph3 = p.stages[1];
    expect(ph3.enrollmentClamped).toBe(true);
    expect(ph3.enrollmentMonths).toBe(48);
    expect(ph3.enrollmentMonthsRaw).toBeGreaterThan(90);
  });

  it("a not-yet-complete current trial keeps its (bounded) accrual", () => {
    const st = plan([stage({
      isCurrentTrial: true, enrollmentComplete: false, n: 300, enrollmentRatePerMonth: 15,
    })]).stages[0];
    expect(st.enrollmentComplete).toBe(false);
    expect(st.enrollmentMonths).toBeCloseTo(20, 6); // 300 / 15, credible → unchanged
  });
});

describe("Fix #1 — regression: credible timelines are untouched", () => {
  it("(iv) a sane stage passes through with no conversion and no clamp", () => {
    const st = plan([stage({
      isCurrentTrial: true, phase: "Phase 2", n: 300, enrollmentRatePerMonth: 15,
      treatmentObsMonths: 12, startupCushionMonths: 6,
    })]).stages[0];
    expect(st.treatmentObsWasWeeks).toBe(false);
    expect(st.treatmentObsClamped).toBe(false);
    expect(st.enrollmentClamped).toBe(false);
    expect(st.treatmentObsMonths).toBe(12);
    expect(st.startupCushionMonths).toBe(6);
    expect(st.enrollmentMonths).toBeCloseTo(20, 6);
    expect(st.durationMonths).toBeCloseTo(20 + 12 + 6, 6);
  });

  it("resolves the tau-shaped catastrophe: total drops from ~353mo to a credible range", () => {
    // The exact live inputs that produced launch 2055: Ph2 62mo enroll (fully
    // enrolled) + 76mo(wk) obs; Ph3 100mo enroll + 96mo(wk) obs.
    const p = plan([
      stage({ id: "s1", phase: "Phase 2", isCurrentTrial: true, enrollmentComplete: true,
        n: 372, enrollmentRatePerMonth: 6, treatmentObsMonths: 76, startupCushionMonths: 5 }),
      stage({ id: "s2", phase: "Phase 3", isCurrentTrial: false,
        n: 280, enrollmentRatePerMonth: 2.8, treatmentObsMonths: 96, startupCushionMonths: 6,
        trialDesign: { ...design, n: 280 } }),
    ]);
    expect(p.totalDurationMonths).toBeGreaterThan(80);
    expect(p.totalDurationMonths).toBeLessThan(150); // was ~353
    expect(p.stages[0].enrollmentComplete).toBe(true);
    expect(p.stages[0].treatmentObsWasWeeks).toBe(true);
    expect(p.stages[1].enrollmentClamped).toBe(true);
    expect(p.stages[1].treatmentObsWasWeeks).toBe(true);
    // Launch year is now credible (within ~15y of today, not 30+).
    const yearsOut = new Date().getFullYear() + p.totalDurationMonths / 12;
    expect(p.impliedLaunchYear).toBeLessThan(yearsOut + 2);
  });
});

describe("Fix #1 — GUARDRAIL: durations never move a probability", () => {
  it("identical design with sane vs absurd durations yields identical P(approval)", () => {
    const sane = plan([stage({
      isCurrentTrial: true, treatmentObsMonths: 12, startupCushionMonths: 6, enrollmentRatePerMonth: 15,
    })]);
    const absurd = plan([stage({
      isCurrentTrial: true, treatmentObsMonths: 76, startupCushionMonths: 40, enrollmentRatePerMonth: 2,
    })]);
    expect(absurd.pApproval).toBeCloseTo(sane.pApproval, 12);
    expect(absurd.stages[0].trialSuccessProb).toBeCloseTo(sane.stages[0].trialSuccessProb, 12);
    expect(absurd.stages[0].trialSuccessProbRaw).toBeCloseTo(sane.stages[0].trialSuccessProbRaw, 12);
    // The timelines DO differ — that's the whole point (probability decoupled from clock).
    expect(absurd.totalDurationMonths).not.toBeCloseTo(sane.totalDurationMonths, 1);
  });
});

describe("Fix #1 — CT.gov enrollment-status mapping", () => {
  it("maps closed-to-accrual statuses to complete, open ones to incomplete", () => {
    expect(isEnrollmentComplete("ACTIVE_NOT_RECRUITING")).toBe(true);
    expect(isEnrollmentComplete("COMPLETED")).toBe(true);
    expect(isEnrollmentComplete("ENROLLING_BY_INVITATION")).toBe(true);
    expect(isEnrollmentComplete("RECRUITING")).toBe(false);
    expect(isEnrollmentComplete("NOT_YET_RECRUITING")).toBe(false);
    expect(isEnrollmentComplete(undefined)).toBe(false);
  });
});
