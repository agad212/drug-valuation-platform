import { describe, it, expect } from "vitest";
import { validateDesignSpec, resolveStageTarget } from "../trial-design-interpreter";
// computeStageRR is imported HERE (in the test) to prove the spec is Layer-1-consumable — the
// interpreter module itself imports NO Layer-1 power function (the no-leak import-graph proof).
import { computeStageRR, type RRTrialDesign } from "../bayesian-rr";

describe("Layer 2 interpreter — no-leak (LLM specifies, never emits the number)", () => {
  it("WHITELIST parse: hallucinated power / pApproval / eNPV keys are DROPPED, never enter the spec", () => {
    const { spec } = validateDesignSpec({
      designType: "rct",
      alpha: { value: 0.025, sided: 1 },
      power: 0.8, // ← LLM hallucination
      pApproval: 0.6, // ← LLM hallucination
      eNPVM: 1234, // ← LLM hallucination
      trialSuccessProb: 0.9, // ← LLM hallucination
    });
    expect(spec.designType).toBe("rct");
    expect(spec.alpha?.value).toBe(0.025);
    expect("power" in spec).toBe(false);
    expect("pApproval" in spec).toBe(false);
    expect("eNPVM" in spec).toBe(false);
    expect("trialSuccessProb" in spec).toBe(false);
  });

  it("the result carries NO numeric-result field (only spec / flags / assumptions / rejected)", () => {
    const res = validateDesignSpec({ designType: "rct", alpha: { value: 0.025 } });
    expect(Object.keys(res).sort()).toEqual(["assumptions", "flags", "rejected", "spec"]);
  });
});

describe("Layer 2 interpreter — two-stage validation gate (non-vacuity)", () => {
  it("VALID supported spec (OBF K2 + one-sided α=0.025) passes; assumptions record the alpha override", () => {
    const { spec, flags, assumptions, rejected } = validateDesignSpec({
      designType: "rct",
      regulatoryContext: "confirmatory",
      n: 200,
      alpha: { value: 0.025, sided: 1 },
      sequential: { lookFractions: [0.5, 1], spending: "OBF" },
    });
    expect(rejected).toBe(false);
    expect(flags.filter((f) => f.severity === "reject")).toHaveLength(0);
    expect(spec.alpha).toEqual({ value: 0.025, sided: 1 });
    expect(spec.sequential).toEqual({ lookFractions: [0.5, 1], spending: "OBF" });
    // alpha override surfaced as a structured assumption
    expect(assumptions.some((a) => a.field === "alpha.value" && a.source === "user" && /overrides confirmatory/.test(String(a.value)))).toBe(true);
  });

  it("NON-MONOTONIC look fractions → semantic reject + flag; sequential dropped", () => {
    const { spec, flags } = validateDesignSpec({ designType: "rct", sequential: { lookFractions: [0.7, 0.3, 1] } });
    expect(spec.sequential).toBeUndefined();
    expect(flags.some((f) => f.code === "bad-look-fractions" && f.severity === "reject")).toBe(true);
  });

  it("ALPHA out of range (0.7) → rejected + flag; alpha not set (regulatory default used)", () => {
    const { spec, flags } = validateDesignSpec({ designType: "rct", alpha: { value: 0.7 } });
    expect(spec.alpha).toBeUndefined();
    expect(flags.some((f) => f.code === "bad-alpha" && f.severity === "reject")).toBe(true);
  });

  it("UNSUPPORTED (conditional-power futility) → flag + fallback, BOTH flags surfaced; efficacy-only kept", () => {
    const { spec, flags } = validateDesignSpec({
      designType: "rct",
      sequential: { lookFractions: [0.5, 1], spending: "OBF", futility: { futilityType: "conditional-power", binding: true } },
    });
    expect(flags.some((f) => f.code === "cp-futility-unsupported" && f.severity === "fallback")).toBe(true); // "not computable"
    expect(flags.some((f) => f.code === "cp-futility-fallback" && f.severity === "info")).toBe(true); // "computed with Y instead"
    expect(spec.sequential).toBeTruthy(); // efficacy-only group-sequential survives
    expect(spec.sequential!.futility).toBeUndefined(); // CP futility NOT silently approximated
  });

  it("UNSUPPORTED (sequential + Bayesian = predictive-probability) → both flags; Bayesian dropped, GS kept", () => {
    const { spec, flags } = validateDesignSpec({
      designType: "rct",
      sequential: { lookFractions: [0.5, 1] },
      bayesian: { refTheta: 0.3, postThreshold: 0.95 },
    });
    expect(flags.some((f) => f.code === "predictive-probability-unsupported")).toBe(true);
    expect(flags.some((f) => f.code === "predictive-probability-fallback")).toBe(true);
    expect(spec.sequential).toBeTruthy();
    expect(spec.bayesian).toBeUndefined();
  });

  it("UNDER-SPECIFIED group-sequential → labeled defaults (OBF, K=2) surfaced as assumptions", () => {
    const { spec, assumptions } = validateDesignSpec({ designType: "rct", sequential: { lookFractions: [] } });
    expect(spec.sequential!.lookFractions).toEqual([0.5, 1]);
    expect(spec.sequential!.spending).toBe("OBF");
    expect(assumptions.some((a) => a.field === "sequential.lookFractions" && a.source === "default")).toBe(true);
    expect(assumptions.some((a) => a.field === "sequential.spending" && a.source === "default")).toBe(true);
  });

  it("EFFECT-ANCHOR never defaulted: TTE without expectedHR → rejected (not a guessed HR)", () => {
    const { spec, flags } = validateDesignSpec({ designType: "rct", tte: { events: 300 } });
    expect(spec.tte).toBeUndefined();
    expect(flags.some((f) => f.code === "tte-incomplete" && f.severity === "reject")).toBe(true);
  });

  it("single-arm native TTE → flag + RR-proxy fallback (both surfaced)", () => {
    const { spec, flags } = validateDesignSpec({ designType: "single_arm", tte: { expectedHR: 0.6, events: 200 } });
    expect(flags.some((f) => f.code === "tte-single-arm-unsupported")).toBe(true);
    expect(flags.some((f) => f.code === "tte-single-arm-fallback")).toBe(true);
    expect(spec.tte).toBeUndefined(); // not natively computed; Layer-1 uses the RR-proxy
  });

  it("UNSUPPORTED passthrough: `unsupported` string → BOTH flags (not computable + computed with Y); never a spec field", () => {
    const { spec, flags } = validateDesignSpec({ designType: "rct", unsupported: "adaptive sample-size re-estimation" });
    expect(flags.some((f) => f.code === "design-unsupported" && f.severity === "fallback")).toBe(true); // "not computable yet"
    expect(flags.some((f) => f.code === "design-unsupported-fallback" && f.severity === "info")).toBe(true); // "computed with Y instead"
    expect(spec.designType).toBe("rct"); // the closest supported spec survives
    expect("unsupported" in spec).toBe(false); // string signal only — never a spec field (no-leak intact)
  });

  it("malformed top-level (not an object) → rejected, empty spec (base path)", () => {
    const res = validateDesignSpec("give me a group sequential design" as unknown);
    expect(res.rejected).toBe(true);
    expect(res.spec).toEqual({});
  });
});

describe("Layer 2 interpreter — stage-addressable (stageTarget)", () => {
  it("unstated stageTarget with design content → defaults to pivotal, SURFACED as an assumption (never silent whole-plan)", () => {
    const { spec, assumptions } = validateDesignSpec({ designType: "rct", sequential: { lookFractions: [0.5, 1] } });
    expect(spec.stageTarget).toBe("pivotal");
    expect(assumptions.some((a) => a.field === "stageTarget" && a.source === "default")).toBe(true);
  });
  it("explicit stageTarget → carried as a user assumption", () => {
    const { spec, assumptions } = validateDesignSpec({ sequential: { lookFractions: [0.5, 1] }, stageTarget: "Phase 3" });
    expect(spec.stageTarget).toBe("Phase 3");
    expect(assumptions.some((a) => a.field === "stageTarget" && a.source === "user")).toBe(true);
  });
  it("empty spec → no stageTarget (nothing to address)", () => {
    expect(validateDesignSpec({}).spec.stageTarget).toBeUndefined();
  });
  it("resolveStageTarget: phase match / pivotal / index / out-of-range→flag / unresolved→flag", () => {
    const stages = [{ phase: "Phase 2" }, { phase: "Phase 3" }];
    expect(resolveStageTarget("Phase 3", stages).index).toBe(1);
    expect(resolveStageTarget("pivotal", stages).index).toBe(1);
    expect(resolveStageTarget(0, stages).index).toBe(0);
    const oob = resolveStageTarget(9, stages);
    expect(oob.index).toBe(1);
    expect(oob.flag?.code).toBe("stage-target-out-of-range");
    const un = resolveStageTarget("Phase 1", stages);
    expect(un.index).toBe(1);
    expect(un.flag?.code).toBe("stage-target-unresolved");
  });
});

describe("Layer 2 interpreter — the validated spec is Layer-1-consumable (boundary works end-to-end)", () => {
  const MIX = [{ w: 1, mu: 1.0, sigma2: 0.15 }]; // prior mean ≈ 0.5
  it("an interpreted GS spec, mapped to RRTrialDesign, computes a real number via computeStageRR", () => {
    const { spec } = validateDesignSpec({
      designType: "rct",
      n: 200,
      alpha: { value: 0.025, sided: 1 },
      sequential: { lookFractions: [0.5, 1], spending: "OBF" },
    });
    // map the interpreter's spec onto the Layer-1 design object (the deferred bridge does this in prod)
    const rrDesign: RRTrialDesign = {
      designType: "rct",
      endpointType: "surrogate",
      populationType: "broad",
      regulatoryContext: "confirmatory",
      alpha: spec.alpha,
      sequential: spec.sequential,
    };
    const gs = computeStageRR(MIX, spec.n!, 0.15, rrDesign).trialSuccessProb;
    const fixed = computeStageRR(MIX, spec.n!, 0.15, { ...rrDesign, sequential: undefined }).trialSuccessProb;
    expect(gs).toBeGreaterThan(0);
    expect(gs).toBeLessThanOrEqual(1);
    expect(gs).not.toBeCloseTo(fixed, 4); // the interpreted sequential design actually engaged Layer-1
  });
});
