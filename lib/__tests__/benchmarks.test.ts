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

import { ipfEndpointFamilyMatch, pinEpi } from "../indication-benchmarks";
import { inferTherapeuticArea } from "../financial-pins";

describe("IPF comparator pin - endpoint-family gate (8/8 review)", () => {
  it("pins 0.68 for a rate stage with no endpoint text (legacy behavior preserved)", () => {
    const pin = pinComparator("idiopathic pulmonary fibrosis", true);
    expect(pin?.nullResponseRate).toBe(0.68);
  });

  it("pins for the event-free/decline family the ASCEND null actually describes", () => {
    const pin = pinComparator("IPF", true, "proportion event-free at 52 weeks (no >=10% relative FVC decline or death)");
    expect(pin?.nullResponseRate).toBe(0.68);
  });

  it("refuses an IMPROVEMENT-type responder endpoint (contains FVC but true null ~0.10, not 0.68)", () => {
    expect(pinComparator("IPF", true, "proportion with >=5% absolute FVC improvement at 24 weeks")).toBeNull();
    expect(ipfEndpointFamilyMatch(">=5% absolute FVC improvement")).toBe(false);
  });

  it("refuses an unrelated rate endpoint outright", () => {
    expect(pinComparator("IPF", true, "objective response rate (ORR)")).toBeNull();
  });

  it("still never pins non-rate stages", () => {
    expect(pinComparator("idiopathic pulmonary fibrosis", false)).toBeNull();
  });
});

describe("inferTherapeuticArea routes IPF to the orphan cost band (was general)", () => {
  it("IPF phrasings -> rare_orphan", () => {
    expect(inferTherapeuticArea("Idiopathic Pulmonary Fibrosis")).toBe("rare_orphan");
    expect(inferTherapeuticArea("progressive pulmonary fibrosis (PPF)")).toBe("rare_orphan");
  });
  it("oncology strings are untouched", () => {
    expect(inferTherapeuticArea("metastatic colorectal cancer")).toBe("oncology");
  });
});

describe("pinEpi - cited epidemiology bands (module 3c)", () => {
  it("IPF gets the cited US bands; unknown indications get null", () => {
    const pin = pinEpi("Idiopathic Pulmonary Fibrosis (IPF)");
    expect(pin).not.toBeNull();
    expect(pin!.usDiagnosedLow).toBeLessThan(pin!.usDiagnosedHigh);
    expect(pin!.treatedPctLow).toBeLessThan(pin!.treatedPctHigh);
    expect(pin!.source).toMatch(/Raghu|claims/i);
    expect(pinEpi("metastatic breast cancer")).toBeNull();
  });
});
