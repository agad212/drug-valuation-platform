import { describe, it, expect } from "vitest";
import { sigma2FromBounds, rangeIncoherence, crossCheckDisagreement, validateElicitationFindings } from "../elicitation";
import { computeDevPlan, type DevStageInput } from "../dev-plan";
import { mixtureFromMssVariance } from "../effect-prior";
import type { TrialDesignInputs } from "../ptrs-trial";

// ─── Deterministic elicitation core (module 1) ────────────────────────────────────────────────

describe("sigma2FromBounds — σ² from an elicited 15/85 range", () => {
  it("computes σ = width/2.073 (z(0.85)≈1.0364 both sides): range 10–20% → σ²≈0.002327", () => {
    const s2 = sigma2FromBounds(0.10, 0.20)!;
    expect(s2).toBeCloseTo(Math.pow(0.10 / (2 * 1.0364), 2), 10);
    expect(s2).toBeCloseTo(0.002327, 4);
  });

  it("rejects junk (caller keeps legacy behavior): reversed, out-of-domain, non-numeric", () => {
    expect(sigma2FromBounds(0.20, 0.10)).toBeNull();
    expect(sigma2FromBounds(0, 0.2)).toBeNull();
    expect(sigma2FromBounds(0.1, 1)).toBeNull();
    expect(sigma2FromBounds("0.1" as unknown, 0.2)).toBeNull();
  });
});

describe("range coherence + cross-check framing", () => {
  it("central outside its own stated range is named as incoherent", () => {
    expect(rangeIncoherence(0.4, 0.3, 0.7, "x")).toMatch(/BELOW the stated low/);
    expect(rangeIncoherence(0.4, 0.8, 0.7, "x")).toMatch(/ABOVE the stated high/);
    expect(rangeIncoherence(0.4, 0.5, 0.7, "x")).toBeNull();
  });

  it("probability vs 'N of 10' framing: agreement passes, disagreement is named with both numbers", () => {
    expect(crossCheckDisagreement(0.55, 5)).toBeNull();       // 55% vs 50% — within tolerance
    expect(crossCheckDisagreement(0.55, 2)).toMatch(/55% vs .*2 of 10.*20%/); // framings disagree
    expect(crossCheckDisagreement(0.55, 47)).toBeNull();      // junk frequency ignored
  });
});

describe("validateElicitationFindings — the checker gate (fresh objects, checked enums)", () => {
  const ALLOWED = ["replicationRisk", "comparatorRange", "general"];

  it("valid findings pass, prefixed with the quantity; invented quantities/severities/numbers cannot survive", () => {
    const out = validateElicitationFindings({
      findings: [
        { quantity: "replicationRisk", severity: "medium", message: "tally counts pamrevlumab twice under two names", adjustedPFail: 0.7 },
        { quantity: "peakSales", severity: "high", message: "nope" },
        { quantity: "general", severity: "catastrophic", message: "nope" },
      ],
    }, ALLOWED);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].message).toMatch(/^AI checker — replicationRisk: tally counts/);
    expect(Object.keys(out.findings[0]).sort()).toEqual(["message", "severity"]);
    expect(out.flags).toHaveLength(2);
  });

  it("garbage → empty + flag; oversized messages truncated + flagged", () => {
    expect(validateElicitationFindings(null, ALLOWED).findings).toEqual([]);
    const long = validateElicitationFindings([{ quantity: "general", severity: "info", message: "y".repeat(900) }], ALLOWED);
    expect(long.findings[0].message.length).toBeLessThanOrEqual(530); // 500 cap + "AI checker — general: " prefix + ellipsis
    expect(long.flags.some((f) => f.includes("truncated"))).toBe(true);
  });
});

// ─── Engine integration: the elicited quantities flow into computeDevPlan ─────────────────────

const design: TrialDesignInputs = {
  n: 100, endpointType: "surrogate", designType: "rct",
  populationType: "broad", placeboResponse: "low", regulatoryContext: "standard",
};
const stage = (o: Partial<DevStageInput> = {}): DevStageInput => ({
  id: "s1", name: "S", phase: "Phase 2", n: 100, cpp: 100000, trialDesign: design,
  isCurrentTrial: true, enrollmentRatePerMonth: 5, treatmentObsMonths: 9, startupCushionMonths: 6, ...o,
});
const mixture = mixtureFromMssVariance(0.5, 0.05);

// RECONCILED (§1.6, same-day): originally written against an RCT stage. The concurrent-control
// rule (benchmark variance applies ONLY to single-arm designs — the engine's own documented
// convention, live-verified suppressing RCT power on 8/7) means the derivation-use assertions
// belong on a SINGLE-ARM stage; the RCT case now asserts the EXCLUSION.
describe("computeDevPlan — elicited comparator range: derived σ² for single-arm, EXCLUDED for RCT", () => {
  const singleArm = { ...design, designType: "single_arm" as const };

  it("SINGLE-ARM: σ² derived from the range (P moves vs raw), flag shows derivation + superseded raw value", () => {
    const raw = computeDevPlan(mixture, 0.1, { stages: [stage({ trialDesign: singleArm, comparatorSigma2: 0.02 })], regulatoryContext: "standard" }, 0);
    const elicited = computeDevPlan(mixture, 0.1, {
      stages: [stage({ trialDesign: singleArm, comparatorSigma2: 0.02, comparatorRateLow: 0.10, comparatorRateHigh: 0.20 })],
      regulatoryContext: "standard",
    }, 0);
    expect(elicited.stages[0].comparatorSigma2Effective).toBeCloseTo(0.002327, 4);
    // (No P-movement assertion: in this configuration the integral is nearly invariant to the
    // benchmark width — the EFFECTIVE σ² value + flags are the contract under test.)
    expect(elicited.stages[0].riskFlags.some((f) => /DERIVED from the elicited 15\/85 range \[10–20%\]/.test(f.message) && /supersedes the raw emitted σ² 0.02/.test(f.message))).toBe(true);
    expect(raw.stages[0].comparatorSigma2Effective).toBe(0.02);
  });

  it("RCT: benchmark variance EXCLUDED from power (raw or elicited) — effective σ² is 0, named on a flag", () => {
    const rct = computeDevPlan(mixture, 0.1, {
      stages: [stage({ comparatorSigma2: 0.02, comparatorRateLow: 0.10, comparatorRateHigh: 0.20 })],
      regulatoryContext: "standard",
    }, 0);
    expect(rct.stages[0].comparatorSigma2Effective).toBe(0);
    expect(rct.stages[0].riskFlags.some((f) => /EXCLUDED from the power computation/.test(f.message) && /concurrent-control RCT/.test(f.message))).toBe(true);
    // And the RCT's power equals the clean-comparator computation (identical to σ² never emitted)
    const clean = computeDevPlan(mixture, 0.1, { stages: [stage()], regulatoryContext: "standard" }, 0);
    expect(rct.stages[0].trialSuccessProbRaw).toBeCloseTo(clean.stages[0].trialSuccessProbRaw, 12);
  });
});

describe("computeDevPlan — replication elicitation extras (range display, coherence, cross-check)", () => {
  const basis = "IPF: nintedanib replicated; pamrevlumab, zinpentraxin failed after positive Phase 2";

  it("coherent range shows on the flag; disagreeing 'N of 10' framing raises its own flag", () => {
    const plan = computeDevPlan(mixture, 0.1, {
      stages: [stage()], regulatoryContext: "standard",
      replicationRisk: { pFail: 0.55, basis, pFailLow: 0.4, pFailHigh: 0.7, crossCheckOutOf10: 2 },
    }, 0);
    const msgs = plan.stages[0].riskFlags.map((f) => f.message);
    expect(msgs.some((m) => /\[elicited 15\/85 range 40–70%\]/.test(m))).toBe(true);
    expect(msgs.some((m) => /two framings of the same belief disagree/.test(m) && /55% vs/.test(m))).toBe(true);
  });

  it("incoherent range is ignored + named; agreeing framings raise nothing extra; pFail still governs the math", () => {
    const bad = computeDevPlan(mixture, 0.1, {
      stages: [stage()], regulatoryContext: "standard",
      replicationRisk: { pFail: 0.55, basis, pFailLow: 0.6, pFailHigh: 0.7, crossCheckOutOf10: 5 },
    }, 0);
    const msgs = bad.stages[0].riskFlags.map((f) => f.message);
    expect(msgs.some((m) => /incoherent elicitation, range ignored/.test(m))).toBe(true);
    expect(msgs.some((m) => /\[elicited 15\/85 range/.test(m))).toBe(false);
    expect(msgs.some((m) => /two framings/.test(m))).toBe(false);
    expect(bad.replicationWeightApplied).toBe(0.55);
    // And the elicitation extras change NO probability (display + coherence only in v1)
    const plain = computeDevPlan(mixture, 0.1, { stages: [stage()], regulatoryContext: "standard", replicationRisk: { pFail: 0.55, basis } }, 0);
    expect(bad.pApproval).toBeCloseTo(plain.pApproval, 12);
  });
});

describe("computeDevPlan — checker findings ride the stage riskFlags rail", () => {
  it("attached findings render on the stage; absent → nothing", () => {
    const plan = computeDevPlan(mixture, 0.1, {
      stages: [stage({ elicitationFindings: [{ severity: "medium", message: "AI checker — replicationRisk: tally arithmetic implies ~0.67, stated 0.52" }] })],
      regulatoryContext: "standard",
    }, 0);
    expect(plan.stages[0].riskFlags.some((f) => f.severity === "medium" && /AI checker — replicationRisk/.test(f.message))).toBe(true);
  });
});

import { revenueCoherenceFlags, rowDivergenceRatio } from "../elicitation";

describe("revenueCoherenceFlags (module 3 rails, moved to lib per 8/8 review)", () => {
  // "Fully coherent" now includes the 3c structures: an epi funnel that multiplies out to the
  // stated count (100k × 50% × 40% × 100% = 20,000) and a non-crowded at-launch competitor set.
  const coherent = {
    peakSalesM: 600, bearM: 200, bullM: 1500,
    competitorsAtLaunch: [{ name: "IncumbentX", status: "approved-incumbent" }],
    marketContext: {
      tamM: 3000, penetrationPct: 20, pricingPerYear: 150000, eligiblePatients: 20000,
      epi: { prevalence: 100000, diagnosedPct: 50, treatedPct: 40, accessiblePct: 100, basis: "test funnel" },
    },
  };

  it("a fully coherent emission produces zero flags", () => {
    expect(revenueCoherenceFlags(coherent)).toEqual([]);
  });

  it("TAM vs patients x price contradiction is named (the 8/8 live finding)", () => {
    const f = revenueCoherenceFlags({ ...coherent, marketContext: { ...coherent.marketContext, eligiblePatients: 80000 } });
    expect(f.some((x) => x.includes("TAM arithmetic incoherent"))).toBe(true);
  });

  it("tamM without a patient count -> unverifiable flag", () => {
    const f = revenueCoherenceFlags({ ...coherent, marketContext: { ...coherent.marketContext, eligiblePatients: null } });
    expect(f.some((x) => x.includes("eligiblePatients not emitted"))).toBe(true);
  });

  it("bearM of exactly 0 still runs the ordering check (old > 0 guard skipped it)", () => {
    const f = revenueCoherenceFlags({ ...coherent, bearM: 0, bullM: 500 }); // bull < base: violated
    expect(f.some((x) => x.includes("ordering violated"))).toBe(true);
  });

  it("bearM of exactly 0 with coherent ordering is accepted without flags", () => {
    expect(revenueCoherenceFlags({ ...coherent, bearM: 0 })).toEqual([]);
  });

  it("suspiciously narrow p05-p95 spread is flagged (provisional 40% floor)", () => {
    const f = revenueCoherenceFlags({ ...coherent, bearM: 550, bullM: 700 });
    expect(f.some((x) => x.includes("suspiciously narrow"))).toBe(true);
  });

  it("non-numeric / NaN inputs never crash and never fake a verdict", () => {
    const f = revenueCoherenceFlags({ peakSalesM: NaN, bearM: undefined, bullM: 1500,
      marketContext: { tamM: "3,000" as unknown as number, pricingPerYear: 150000, eligiblePatients: 20000 } });
    expect(Array.isArray(f)).toBe(true);
    expect(f.some((x) => x.includes("NaN"))).toBe(false);
  });

  it("rowDivergenceRatio fires at >=2x / <=0.5x and stays silent inside", () => {
    expect(rowDivergenceRatio(2450, 650)).not.toBeNull();  // the 8/8 4x disagreement
    expect(rowDivergenceRatio(800, 650)).toBeNull();
    expect(rowDivergenceRatio(0, 650)).toBeNull();          // no row peak -> no verdict
    expect(rowDivergenceRatio(NaN, 650)).toBeNull();
  });
});

describe("revenueCoherenceFlags - module 3c rails (epi funnel, library anchor, at-launch field)", () => {
  const base = {
    peakSalesM: 600, bearM: 200, bullM: 1500,
    competitorsAtLaunch: [{ name: "IncumbentX", status: "approved-incumbent" }],
    marketContext: {
      tamM: 3000, penetrationPct: 20, pricingPerYear: 150000, eligiblePatients: 20000,
      epi: { prevalence: 100000, diagnosedPct: 50, treatedPct: 40, accessiblePct: 100, basis: "test" },
    },
  };
  const IPF_PIN = { usDiagnosedLow: 80000, usDiagnosedHigh: 140000, treatedPctLow: 25, treatedPctHigh: 45, source: "cited bands" };

  it("funnel that does not multiply to the stated count -> incoherence flag", () => {
    const f = revenueCoherenceFlags({ ...base, marketContext: { ...base.marketContext, epi: { ...base.marketContext.epi, prevalence: 300000 } } });
    expect(f.some((x) => x.includes("epi funnel incoherent"))).toBe(true);
  });

  it("count asserted without a funnel -> bare-assertion flag", () => {
    const f = revenueCoherenceFlags({ ...base, marketContext: { ...base.marketContext, epi: null } });
    expect(f.some((x) => x.includes("epi funnel not emitted"))).toBe(true);
  });

  it("library anchor: count below the US-treated floor or above the global cap -> flag; inside -> silent", () => {
    const below = revenueCoherenceFlags({ ...base, marketContext: { ...base.marketContext, eligiblePatients: 10000, epi: { prevalence: 50000, diagnosedPct: 50, treatedPct: 40, accessiblePct: 100, basis: "t" } } }, IPF_PIN, 4);
    expect(below.some((x) => x.includes("LIBRARY EPI ANCHOR"))).toBe(true);
    const above = revenueCoherenceFlags({ ...base, marketContext: { ...base.marketContext, eligiblePatients: 400000, epi: { prevalence: 2000000, diagnosedPct: 50, treatedPct: 40, accessiblePct: 100, basis: "t" } } }, IPF_PIN, 4);
    expect(above.some((x) => x.includes("LIBRARY EPI ANCHOR"))).toBe(true);
    const inside = revenueCoherenceFlags({ ...base, marketContext: { ...base.marketContext, eligiblePatients: 90000, epi: { prevalence: 450000, diagnosedPct: 50, treatedPct: 40, accessiblePct: 100, basis: "t" } } }, IPF_PIN, 4);
    expect(inside.some((x) => x.includes("LIBRARY EPI ANCHOR"))).toBe(false);
  });

  it("penetration undefended (no at-launch set) -> flag", () => {
    const f = revenueCoherenceFlags({ ...base, competitorsAtLaunch: [] });
    expect(f.some((x) => x.includes("at-launch competitor set not emitted"))).toBe(true);
  });

  it("high share against a crowded at-launch field -> flag; modest share -> silent", () => {
    const crowded = [
      { name: "A", status: "approved-incumbent" },
      { name: "B", status: "approved-incumbent" },
      { name: "C", status: "likely-approved-by-launch" },
    ];
    const hot = revenueCoherenceFlags({ ...base, competitorsAtLaunch: crowded, marketContext: { ...base.marketContext, penetrationPct: 30 } });
    expect(hot.some((x) => x.includes("expected non-generic competitors at launch"))).toBe(true);
    const ok = revenueCoherenceFlags({ ...base, competitorsAtLaunch: crowded });
    expect(ok.some((x) => x.includes("expected non-generic competitors"))).toBe(false);
  });
});
