import { describe, it, expect } from "vitest";
import { validateIndicationStructure } from "../indication-structure-interpreter";

// Ordered plan ids: index 0 is the LEAD (always independent). refs may point at any of these.
const IDS = ["lead", "b", "c", "d"];
const rel = (r: ReturnType<typeof validateIndicationStructure>, id: string) => r.relationships.find((x) => x.id === id);
const hasFlag = (r: ReturnType<typeof validateIndicationStructure>, code: string) => r.flags.some((f) => f.code === code);

describe("structure interpreter — no-leak (LLM specifies structure, never a number)", () => {
  it("the result carries ONLY { relationships, flags, assumptions, rejected } — no numeric field", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "independent", ref: null, rationale: "disjoint" }] }, IDS);
    expect(Object.keys(res).sort()).toEqual(["assumptions", "flags", "rejected", "relationships"]);
    res.relationships.forEach((r) => expect(Object.keys(r).sort()).toEqual(["id", "indicationRelationship", "rationale"]));
  });

  it("WHITELIST: hallucinated numeric keys (eNPV / ptrs / weight / probability) are DROPPED, never surface", () => {
    const res = validateIndicationStructure(
      { relationships: [{ id: "b", relationship: "conditional-on", ref: "lead", rationale: "gated", eNPV: 1200, ptrs: 0.6, weight: 0.5, probability: 0.3 }] },
      IDS,
    );
    const b = rel(res, "b")!;
    expect(b.indicationRelationship).toBe("conditional-on:lead"); // the LEGIT structure survives
    expect(Object.keys(b)).toEqual(["id", "indicationRelationship", "rationale"]);
  });

  it("SPLIT-FIELD: the validator CONSTRUCTS the packed string; a packed string from the LLM is not a valid label", () => {
    // an LLM that (wrongly) emits the packed string in `relationship` is treated as an unknown label → demoted.
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "conditional-on:lead", ref: null, rationale: "packed" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(hasFlag(res, "structure-bad-label")).toBe(true);
  });
});

describe("structure interpreter — clean relationships SURVIVE the gate and construct the packed string", () => {
  it("clean independent → 'independent', recorded as an llm assumption, no flags", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "independent", ref: null, rationale: "disjoint population" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(res.assumptions.find((a) => a.id === "b")!.source).toBe("llm");
    expect(res.flags.length).toBe(0);
    expect(res.rejected).toBe(false);
  });

  it("clean conditional → 'conditional-on:<id>' (constructed after resolving ref)", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "conditional-on", ref: "lead", rationale: "b only funded if lead PoC succeeds" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("conditional-on:lead");
    expect(res.flags.length).toBe(0);
  });

  it("clean sequential → 'sequential-after:<id>'", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "sequential-after", ref: "lead", rationale: "b trial starts after lead completes" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("sequential-after:lead");
    expect(res.flags.length).toBe(0);
  });
});

describe("structure interpreter — VALIDATION GATE: each branch fires + falls back to independent (both flags)", () => {
  it("malformed payload (not an object) → rejected, empty relationships (base path → all independent)", () => {
    const res = validateIndicationStructure("give me a structure", IDS);
    expect(res.rejected).toBe(true);
    expect(res.relationships).toEqual([]);
  });

  it("no `relationships` array → rejected", () => {
    expect(validateIndicationStructure({ foo: 1 }, IDS).rejected).toBe(true);
  });

  it("unknown label → demote + bad-label + fallback-independent (both flags)", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "co-dependent", ref: "lead", rationale: "x" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(hasFlag(res, "structure-bad-label")).toBe(true);
    expect(hasFlag(res, "structure-fallback-independent")).toBe(true);
  });

  it("missing rationale → demote + missing-rationale", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "conditional-on", ref: "lead", rationale: "  " }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(hasFlag(res, "structure-missing-rationale")).toBe(true);
  });

  it("missing ref (non-independent, ref null) → demote + missing-ref (both flags)", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "conditional-on", ref: null, rationale: "gated but no ref" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(hasFlag(res, "structure-missing-ref")).toBe(true);
    expect(hasFlag(res, "structure-fallback-independent")).toBe(true);
  });

  it("dangling ref (points at a non-indication) → demote + dangling-ref (the engine does NOT self-defend)", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "sequential-after", ref: "ghost", rationale: "after a phantom" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(hasFlag(res, "structure-dangling-ref")).toBe(true);
    expect(hasFlag(res, "structure-fallback-independent")).toBe(true);
  });

  it("self-reference (ref === id) → demote + self-reference", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "b", relationship: "conditional-on", ref: "b", rationale: "itself" }] }, IDS);
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(hasFlag(res, "structure-self-reference")).toBe(true);
  });

  it("lead as SOURCE → rejected (the lead is always independent); no relationship emitted for it", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "lead", relationship: "conditional-on", ref: "b", rationale: "x" }] }, IDS);
    expect(hasFlag(res, "structure-lead-not-independent")).toBe(true);
    expect(rel(res, "lead")).toBeUndefined();
  });

  it("unknown indication id → dropped with a flag, no relationship", () => {
    const res = validateIndicationStructure({ relationships: [{ id: "zzz", relationship: "independent", ref: null, rationale: "x" }] }, IDS);
    expect(hasFlag(res, "structure-unknown-indication")).toBe(true);
    expect(res.relationships.length).toBe(0);
  });
});

describe("structure interpreter — CYCLES are rejected; acyclic CHAINS are allowed + flagged single-level", () => {
  it("2-cycle (b→c, c→b) → BOTH demoted to independent + structure-cycle flags", () => {
    const res = validateIndicationStructure(
      { relationships: [
        { id: "b", relationship: "conditional-on", ref: "c", rationale: "b needs c" },
        { id: "c", relationship: "conditional-on", ref: "b", rationale: "c needs b" },
      ] },
      IDS,
    );
    expect(rel(res, "b")!.indicationRelationship).toBe("independent");
    expect(rel(res, "c")!.indicationRelationship).toBe("independent");
    expect(res.flags.filter((f) => f.code === "structure-cycle").length).toBeGreaterThanOrEqual(2);
  });

  it("longer loop (b→c→d→b) → ALL THREE demoted", () => {
    const res = validateIndicationStructure(
      { relationships: [
        { id: "b", relationship: "conditional-on", ref: "c", rationale: "x" },
        { id: "c", relationship: "sequential-after", ref: "d", rationale: "x" },
        { id: "d", relationship: "conditional-on", ref: "b", rationale: "x" },
      ] },
      IDS,
    );
    ["b", "c", "d"].forEach((id) => expect(rel(res, id)!.indicationRelationship).toBe("independent"));
    expect(res.flags.filter((f) => f.code === "structure-cycle").length).toBe(3);
  });

  it("acyclic chain (c→b, b→lead) → SURVIVES, packed strings built, single-level chain INFO flag on c (no rejects)", () => {
    const res = validateIndicationStructure(
      { relationships: [
        { id: "b", relationship: "conditional-on", ref: "lead", rationale: "b on lead" },
        { id: "c", relationship: "conditional-on", ref: "b", rationale: "c on b" },
      ] },
      IDS,
    );
    expect(rel(res, "b")!.indicationRelationship).toBe("conditional-on:lead");
    expect(rel(res, "c")!.indicationRelationship).toBe("conditional-on:b");
    expect(hasFlag(res, "structure-chain-singlelevel")).toBe(true);
    expect(res.flags.some((f) => f.severity === "reject")).toBe(false);
  });
});
