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

describe("computeDevPlan — elicited comparator range supersedes a raw σ² emission", () => {
  it("range present → σ² derived (P moves vs raw), flag shows the derivation AND the superseded raw value", () => {
    const raw = computeDevPlan(mixture, 0.1, { stages: [stage({ comparatorSigma2: 0.02 })], regulatoryContext: "standard" }, 0);
    const elicited = computeDevPlan(mixture, 0.1, {
      stages: [stage({ comparatorSigma2: 0.02, comparatorRateLow: 0.10, comparatorRateHigh: 0.20 })],
      regulatoryContext: "standard",
    }, 0);
    expect(elicited.stages[0].comparatorSigma2Effective).toBeCloseTo(0.002327, 4);
    expect(elicited.stages[0].trialSuccessProbRaw).not.toBeCloseTo(raw.stages[0].trialSuccessProbRaw, 6);
    expect(elicited.stages[0].riskFlags.some((f) => /DERIVED from the elicited 15\/85 range \[10–20%\]/.test(f.message) && /supersedes the raw emitted σ² 0.02/.test(f.message))).toBe(true);
    // Absent range → legacy raw σ², no derivation flag (capability gate)
    expect(raw.stages[0].comparatorSigma2Effective).toBe(0.02);
    expect(raw.stages[0].riskFlags.some((f) => /DERIVED from the elicited/.test(f.message))).toBe(false);
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
