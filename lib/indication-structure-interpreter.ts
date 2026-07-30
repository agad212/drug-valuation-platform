// lib/indication-structure-interpreter.ts
//
// STRUCTURE GENERATOR — the DETERMINISTIC core. An LLM (in pages/api/indication-structure.ts) reasons
// how a multi-indication asset's NON-LEAD indications relate to the lead / each other and emits a
// STRUCTURED object; THIS module validates it into ResolvedRelationship[] that the cashflow aggregation
// (commit 8eb33cc) consumes via Indication.indicationRelationship.
//
// THE NO-LEAK GUARANTEE (structural, provable — identical discipline to the design interpreter):
//   • The LLM SPECIFIES the structure (a label + a ref + a one-line rationale per non-lead indication);
//     deterministic cashflow code COMPUTES every number from the resolved structure. The LLM NEVER
//     emits a P / revenue / eNPV / weight — there is no such field on the emit type or the return type.
//   • This module imports NOTHING from cashflow / dev-plan / decision-analysis / bayesian-rr. Grep-
//     provable: it returns relationship LABELS, never a number.
//   • WHITELIST parse: only id / relationship / ref / rationale are read per entry. A hallucinated
//     "eNPV" / "ptrs" / "weight" / "probability" key is never read.
//   • SPLIT-FIELD (the key contract decision): the LLM emits `relationship` + `ref` SEPARATELY. It
//     NEVER writes the packed "conditional-on:<id>" string — THIS validator constructs that string only
//     AFTER resolving `ref` against the real plan, so a malformed / dangling / self / cyclic reference
//     can never reach aggregation.
//
// THE VALIDATION GATE is load-bearing: cashflow does NOT self-defend (a dangling sequential-after falls
// back to the lead's launch, a dangling conditional-on to the global P). Every invalid relationship is
// demoted to INDEPENDENT here, with the rejection AND the used-independent BOTH surfaced (never silent).
//
// DIRECTION: the LLM's only degree of freedom is the label; ambiguity → independent (the default). For a
// value-accretive indication, independent is the maximum aggregate (conditional/sequential both strictly
// lower a positive contribution), so the LLM cannot silently understate and cannot emit a value at all.
// Every downward move is an explicit, validated, rationale-bearing relationship, surfaced + vetoable.

export type RelationshipLabel = "independent" | "conditional-on" | "sequential-after";

// What the LLM emits per non-lead indication (whitelist target). NO numeric field — a number cannot be
// represented here (tsc-enforced). `ref` is null for independent, a prerequisite indication id otherwise.
export type RawRelationship = {
  id: string;
  relationship: RelationshipLabel;
  ref: string | null;
  rationale: string;
};

// What the validator returns per indication it resolved. `indicationRelationship` is the packed string
// the engine consumes ("independent" | "conditional-on:<id>" | "sequential-after:<id>"), CONSTRUCTED
// here — never taken verbatim from the LLM. NO numeric field (tsc-enforced).
export type ResolvedRelationship = {
  id: string;
  indicationRelationship: string;
  rationale: string;
};

export type StructureFlag = { code: string; severity: "reject" | "fallback" | "info"; message: string };

// Structured (never prose) surfaced record of every reasoned/defaulted call — the seam the UI reads.
export type StructureAssumption = { id: string; relationship: string; rationale: string; source: "llm" | "default" };

export type StructureResult = {
  relationships: ResolvedRelationship[];
  flags: StructureFlag[];
  assumptions: StructureAssumption[];
  rejected: boolean; // true only when the whole payload was unusable (→ no relationships → all independent)
};

const LABELS: RelationshipLabel[] = ["independent", "conditional-on", "sequential-after"];

// The two-flag pair for every demotion: the requested-and-rejected, then the used-independent. Never a
// silent substitution — both appear so a reviewer sees what was asked and what was actually aggregated.
function demotePair(flags: StructureFlag[], id: string, requested: string, code: string, reason: string): void {
  flags.push({ code: `structure-${code}`, severity: "reject", message: `${id}: requested ${requested} rejected — ${reason}` });
  flags.push({ code: "structure-fallback-independent", severity: "info", message: `${id}: aggregated as independent instead` });
}

type CandidateEdge = { id: string; relationship: "conditional-on" | "sequential-after"; ref: string; rationale: string };

// Directed-graph cycle detection over candidate edges id→ref (BOTH conditional-on and sequential-after).
// DFS three-colouring; a grey→grey back edge marks every node from the target to the current top of the
// recursion stack as part of a cycle. Pure, O(V+E). Self-references are handled upstream, so this only
// finds length-≥2 loops. Returns the set of node ids that lie on any directed cycle.
function findCycleNodes(edges: CandidateEdge[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.id)) adj.set(e.id, []);
    adj.get(e.id)!.push(e.ref);
  }
  const color = new Map<string, 0 | 1 | 2>(); // 0 white, 1 grey (on stack), 2 black
  const inCycle = new Set<string>();
  const stack: string[] = [];
  const dfs = (u: string): void => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const cv = color.get(v) ?? 0;
      if (cv === 1) {
        const start = stack.lastIndexOf(v);
        for (let i = start; i >= 0 && i < stack.length; i++) inCycle.add(stack[i]);
      } else if (cv === 0) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const e of edges) if ((color.get(e.id) ?? 0) === 0) dfs(e.id);
  return inCycle;
}

/**
 * Validate a raw (LLM-emitted) structure object into ResolvedRelationship[] the cashflow aggregation can
 * consume. Pure + deterministic. Anything malformed / missing-ref / dangling / self-referential / cyclic
 * is DEMOTED to independent here (with both flags), so nothing invalid reaches computeOutputs.
 *
 * @param indicationIds ORDERED plan indication ids; index 0 is the LEAD (always independent). `ref` may
 *   point at ANY real indication (including the lead); `id` (the source) must be a real NON-LEAD one.
 */
export function validateIndicationStructure(raw: unknown, indicationIds: string[]): StructureResult {
  const flags: StructureFlag[] = [];
  const assumptions: StructureAssumption[] = [];
  const relationships: ResolvedRelationship[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { relationships, flags: [{ code: "malformed-structure", severity: "reject", message: "structure payload is not an object — no relationships applied (all independent)" }], assumptions, rejected: true };
  }
  const r = raw as Record<string, unknown>;
  const rawList = Array.isArray(r.relationships) ? (r.relationships as unknown[]) : null;
  if (!rawList) {
    return { relationships, flags: [{ code: "malformed-structure", severity: "reject", message: "structure payload has no `relationships` array — all independent" }], assumptions, rejected: true };
  }

  const idSet = new Set(indicationIds);
  const leadId = indicationIds[0];
  const seen = new Set<string>();
  const candidates: CandidateEdge[] = [];

  // ── STAGE 1: shape + reference resolution per entry (whitelist read of id/relationship/ref/rationale) ──
  for (const entryU of rawList) {
    if (typeof entryU !== "object" || entryU === null || Array.isArray(entryU)) {
      flags.push({ code: "structure-malformed-entry", severity: "reject", message: "a relationship entry is not an object — dropped" });
      continue;
    }
    const e = entryU as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : undefined;
    const relationship = e.relationship;
    const ref = typeof e.ref === "string" && e.ref.trim() ? e.ref.trim() : null;
    const rationale = typeof e.rationale === "string" ? e.rationale.trim() : "";

    if (!id || !idSet.has(id)) {
      flags.push({ code: "structure-unknown-indication", severity: "reject", message: `relationship for unknown indication "${String(id)}" — dropped` });
      continue;
    }
    if (id === leadId) {
      flags.push({ code: "structure-lead-not-independent", severity: "reject", message: `${id}: the lead indication is always independent — relationship ignored` });
      continue;
    }
    if (seen.has(id)) {
      flags.push({ code: "structure-duplicate", severity: "reject", message: `${id}: duplicate relationship — first kept` });
      continue;
    }
    seen.add(id);

    if (typeof relationship !== "string" || !LABELS.includes(relationship as RelationshipLabel)) {
      demotePair(flags, id, `relationship "${String(relationship)}"`, "bad-label", "unknown relationship label");
      relationships.push({ id, indicationRelationship: "independent", rationale: rationale || "invalid relationship label — defaulted independent" });
      assumptions.push({ id, relationship: "independent", rationale: rationale || "invalid label", source: "default" });
      continue;
    }
    if (!rationale) {
      demotePair(flags, id, `${relationship}`, "missing-rationale", "no rationale given");
      relationships.push({ id, indicationRelationship: "independent", rationale: "missing rationale — defaulted independent" });
      assumptions.push({ id, relationship: "independent", rationale: "missing rationale", source: "default" });
      continue;
    }

    if (relationship === "independent") {
      relationships.push({ id, indicationRelationship: "independent", rationale });
      assumptions.push({ id, relationship: "independent", rationale, source: "llm" });
      continue;
    }

    // non-independent → needs a valid, resolving, non-self ref
    const rel = relationship as "conditional-on" | "sequential-after";
    if (!ref) {
      demotePair(flags, id, rel, "missing-ref", "no prerequisite `ref` given");
      relationships.push({ id, indicationRelationship: "independent", rationale: `requested ${rel} without a prerequisite — defaulted independent` });
      assumptions.push({ id, relationship: "independent", rationale, source: "default" });
      continue;
    }
    if (ref === id) {
      demotePair(flags, id, `${rel}:${ref}`, "self-reference", "an indication cannot depend on itself");
      relationships.push({ id, indicationRelationship: "independent", rationale: `self-reference — defaulted independent` });
      assumptions.push({ id, relationship: "independent", rationale, source: "default" });
      continue;
    }
    if (!idSet.has(ref)) {
      demotePair(flags, id, `${rel}:${ref}`, "dangling-ref", `prerequisite "${ref}" is not an indication in this plan`);
      relationships.push({ id, indicationRelationship: "independent", rationale: `dangling prerequisite "${ref}" — defaulted independent` });
      assumptions.push({ id, relationship: "independent", rationale, source: "default" });
      continue;
    }
    // passes shape + ref checks → candidate edge (cycle check pending in stage 2)
    candidates.push({ id, relationship: rel, ref, rationale });
  }

  // ── STAGE 2: cycle detection over candidate edges (id→ref, both edge types) ──
  const inCycle = findCycleNodes(candidates);
  const surviving: CandidateEdge[] = [];
  for (const c of candidates) {
    if (inCycle.has(c.id)) {
      demotePair(flags, c.id, `${c.relationship}:${c.ref}`, "cycle", "part of a circular dependency (a relationship loop is not a valid structure)");
      relationships.push({ id: c.id, indicationRelationship: "independent", rationale: `cyclic dependency — defaulted independent` });
      assumptions.push({ id: c.id, relationship: "independent", rationale: c.rationale, source: "default" });
    } else {
      surviving.push(c);
    }
  }

  // ── STAGE 3: construct packed strings for survivors + flag acyclic CHAINS as single-level (allowed) ──
  const survivingSources = new Set(surviving.map((c) => c.id));
  for (const c of surviving) {
    const packed = `${c.relationship}:${c.ref}`;
    relationships.push({ id: c.id, indicationRelationship: packed, rationale: c.rationale });
    assumptions.push({ id: c.id, relationship: packed, rationale: c.rationale, source: "llm" });
    if (survivingSources.has(c.ref)) {
      flags.push({
        code: "structure-chain-singlelevel",
        severity: "info",
        message: `${c.id}: ${c.relationship} ${c.ref}, which itself depends on another indication — conditioned at a SINGLE level (the prerequisite's own P/launch, not cumulative); transitive conditioning is a later refinement`,
      });
    }
  }

  return { relationships, flags, assumptions, rejected: false };
}
