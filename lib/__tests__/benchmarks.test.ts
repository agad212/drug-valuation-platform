import { describe, it, expect } from "vitest";
import { pinComparator, pinPhase3Endpoint, isColorectalMRD } from "../indication-benchmarks";
import { labelBreadthMultiplier, type BaseContext } from "../decision-analysis";
import type { TrialDesignInputs } from "../ptrs-trial";

describe("Part 1 — pinned Phase-2a comparator (MRD+ CRC ctDNA clearance)", () => {
  it("pins deterministically for a rate stage, wider σ² than the LLM's tight value", () => {
    const pin = pinComparator("ctDNA-positive MRD colorectal cancer following curative-intent therapy", true);
    expect(pin).not.toBeNull();
    expect(pin!.nullResponseRate).toBe(0.05);
    expect(pin!.comparatorSigma2).toBeGreaterThan(0.018);
    expect(pin!.source).toMatch(/GALAXY/);
  });

  it("does NOT apply to a time-to-event stage, and falls back for other indications", () => {
    expect(pinComparator("MRD colorectal cancer", false)).toBeNull();
    expect(pinComparator("metastatic breast cancer", true)).toBeNull();
    expect(isColorectalMRD("advanced solid tumor")).toBe(false);
    expect(isColorectalMRD("ctDNA+ MRD colorectal cancer adjuvant")).toBe(true);
  });
});

describe("Part 2 — pinned Phase-3 endpoint (DFS/RFS for MRD+ adjuvant CRC)", () => {
  it("pins Phase 3 to a time-to-event endpoint from precedent", () => {
    const pin = pinPhase3Endpoint("ctDNA+ MRD colorectal cancer adjuvant", "Phase 3");
    expect(pin).not.toBeNull();
    expect(pin!.isTimeToEvent).toBe(true);
    expect(pin!.endpointDescription).toMatch(/DFS|disease-free/i);
  });

  it("does not pin a Phase 2 stage or a non-CRC indication", () => {
    expect(pinPhase3Endpoint("MRD colorectal cancer", "Phase 2")).toBeNull();
    expect(pinPhase3Endpoint("pancreatic cancer", "Phase 3")).toBeNull();
  });
});

describe("Part 3 — label-breadth difficulty multiplier", () => {
  const design = (o: Partial<TrialDesignInputs>): TrialDesignInputs => ({
    n: 200, endpointType: "surrogate", designType: "single_arm",
    populationType: "biomarker_selected", placeboResponse: "low", regulatoryContext: "orphan", ...o,
  });
  const base = { baseTrialDesign: design({}) } as BaseContext;

  it("no penalty for a single tightly-defined indication", () => {
    expect(labelBreadthMultiplier(design({}), base).mult).toBe(1.0);
  });

  it("compounds the penalty for a de-orphaned pan-tumor basket", () => {
    const { mult, reasons } = labelBreadthMultiplier(
      design({ designType: "basket", populationType: "broad", regulatoryContext: "standard" }), base);
    expect(mult).toBeCloseTo(0.60 * 0.80 * 0.88, 6);
    expect(mult).toBeLessThan(0.5);
    expect(reasons.length).toBe(3);
  });

  it("applies only the population term when that is the only change", () => {
    const { mult } = labelBreadthMultiplier(design({ populationType: "broad" }), base);
    expect(mult).toBeCloseTo(0.80, 6);
  });
});
