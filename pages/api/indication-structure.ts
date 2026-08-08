// /api/indication-structure — the STRUCTURE-GENERATOR endpoint.
//
// Reasons how a multi-indication asset's NON-LEAD indications relate (independent / conditional-on /
// sequential-after) via the LLM, then runs the raw emit through the DETERMINISTIC validator
// (lib/indication-structure-interpreter). Returns { relationships, flags, assumptions } — NEVER a P /
// revenue / eNPV number. The cashflow aggregation (8eb33cc) computes the value downstream from the
// resolved relationships.
//
// NO-LEAK: this endpoint imports ONLY the interpreter/validator — no cashflow / dev-plan / decision-
// analysis / bayesian-rr. The LLM emits relationship LABELS + a ref + a rationale; the validator
// whitelists them (any hallucinated numeric key is dropped) and CONSTRUCTS the packed relationship
// string only after resolving ref against the real plan (split-field rule).

import type { NextApiRequest, NextApiResponse } from "next";
import { validateIndicationStructure } from "../../lib/indication-structure-interpreter";
import { runElicitationChecker } from "../../lib/elicitation-checker";
import { logStart, logEnd } from "../../lib/endpoint-timing";

const SYSTEM_PROMPT = `You classify how the NON-LEAD indications of a single drug asset relate to the lead
indication (or to each other), for a risk-adjusted valuation. You SPECIFY the STRUCTURE; deterministic
code downstream COMPUTES every number from it.

ABSOLUTE RULE: NEVER emit a probability, P(approval), peak sales, revenue, eNPV, ROI, weight, or ANY
number. There is no numeric field. If you write one it is discarded — the engine computes all numbers
from your structure, not you. You choose ONLY a relationship label + a prerequisite reference + a reason.

Emit ONE JSON object inside <structure_json>...</structure_json>:
  { "relationships": [ { "id": <indication id>, "relationship": "independent" | "conditional-on" | "sequential-after", "ref": <prerequisite indication id> | null, "rationale": <one short line>, "mechanismSharedWithLead": true | false | null } ] }

mechanismSharedWithLead is an OBSERVABLE FACT, not a dependency: does this indication rely on the SAME
molecular target/mechanism as the LEAD indication? It NEVER justifies conditional-on or sequential-after
on its own (the stated-dependency rule below stands unchanged). The engine uses it only to DISCLOSE that
independent same-mechanism probabilities are treated as uncorrelated — an honesty flag, not a value change.
Emit it truthfully: understating a shared mechanism hides real correlation from the user.

SPLIT FIELDS — emit "relationship" and "ref" SEPARATELY. NEVER write a packed string like
"conditional-on:ind_2". Put the label in "relationship" and the prerequisite's id in "ref". The engine
constructs the packed value itself after checking your ref points at a real indication.

THE THREE RELATIONSHIPS:
- "independent" (ref: null): disjoint patient populations, separate approval paths, no go-decision or
  timing dependency — this indication proceeds regardless of the others. (e.g. an unrelated second
  disease the program pursues in parallel.)
- "conditional-on" (ref: the prerequisite's id): this indication is only pursued/funded IF the
  prerequisite succeeds — a platform/go-decision dependency, OR it shares enough biology that the
  prerequisite's readout genuinely gates the go-decision.
- "sequential-after" (ref: the prerequisite's id): this indication STARTS after the prerequisite
  (shared trial resource / staggered timing), so its launch shifts later — even if its probability is
  independent.

RESOLVE-OR-FLAG (this is a judgment; be honest about uncertainty):
- Emit one entry for EVERY non-lead indication listed below (never the lead — the lead is always
  independent and must not appear).
- CLEAR signal in the evidence → the relationship + a rationale naming the signal.
- A conditional-on or sequential-after call REQUIRES an EXPLICIT stated dependency: the context must
  actually SAY this indication is gated on / funded on another's success (→ conditional-on), OR starts
  after / is staggered behind / shares the trial resources or infrastructure of another (→ sequential-after).
  The discriminator is STATED vs INFERRED. The following facts, ON THEIR OWN, are NOT a dependency — do
  not INFER a relationship from them; default to independent UNLESS the context explicitly states the
  gate or the timing/resource dependency: shared mechanism or target; same development phase; staggered
  or adjacent launch years; sitting under the same broad therapeutic umbrella (e.g. two oncology
  indications); or an inferred "expansion cohort." Co-timing you INFER from dates alone is NOT a signal.
- sequential-after is a TIMING relationship, NOT a probability gate: use it when the context STATES the
  indication starts after / is staggered behind / shares the earlier program's resources or
  infrastructure — even when it is explicitly NOT go-decision-gated. A STATED staggering IS a valid
  sequential-after signal (do not demote it to independent just because it is not a gate).
- A non-independent rationale MUST name the specific stated dependency it relies on (the actual program
  language / source that says this indication is gated on / funded after / timed behind another). If you
  cannot point to a concrete stated dependency, you MUST emit independent. A rationale that only says
  "suggesting" / "likely gated" / "appears to be an expansion" WITHOUT a citable stated dependency is NOT
  permitted for conditional/sequential — that is an inference, and an unsourced dependency is a flag
  (→ independent), not a verdict.
- AMBIGUOUS / no signal → "independent" with a rationale saying so (e.g. "no stated dependency —
  defaulting to independent"). Do NOT guess conditional/sequential when unsure: independent is the
  transparent default, and guessing a dependency silently moves the valuation. Never invent a program
  strategy that isn't supported by the evidence.
- Over-calling conditional/sequential silently LOWERS the valuation exactly as a wrong number would;
  when in doubt, INDEPENDENT.
- "ref" must be the id of one of the indications listed (or the lead). Do not reference anything else.

Base your calls ONLY on the asset facts and per-indication evidence provided (development strategy,
shared mechanism, trial timing, phases, launch years). If nothing supports a dependency, choose
independent.`;

type IndIn = { id?: unknown; name?: unknown; phase?: unknown; launchYear?: unknown; nctId?: unknown };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { drug, mechanism, sponsor, summary, indications } = req.body ?? {};
  if (!Array.isArray(indications) || indications.length < 2) {
    return res.status(400).json({ error: "indications (array of length >= 2) required" });
  }

  // Ordered ids (index 0 = lead) — the validator resolves refs against these.
  const indicationIds: string[] = (indications as IndIn[]).map((i) => String(i?.id ?? "")).filter((s) => s.length > 0);
  if (indicationIds.length !== indications.length) {
    return res.status(400).json({ error: "every indication needs a string id" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  // Build the evidence block. Index 0 is labeled the LEAD (never reasoned); the rest are the targets.
  const lines = (indications as IndIn[]).map((i, idx) => {
    const tag = idx === 0 ? "LEAD (always independent — do NOT emit an entry for it)" : "non-lead";
    return `- id: ${String(i?.id ?? "")} | ${tag} | name: ${String(i?.name ?? "?")} | phase: ${String(i?.phase ?? "?")} | launchYear: ${String(i?.launchYear ?? "?")} | nctId: ${String(i?.nctId ?? "?")}`;
  });
  const userContent = [
    `Asset: ${String(drug ?? "?")}${mechanism ? ` | mechanism: ${String(mechanism)}` : ""}${sponsor ? ` | sponsor: ${String(sponsor)}` : ""}`,
    summary ? `Development context: ${String(summary)}` : "",
    "",
    "Indications (index 0 is the lead):",
    ...lines,
    "",
    "Emit one relationship entry for each NON-LEAD indication (never the lead).",
  ].filter(Boolean).join("\n");

  const __t0 = logStart("indication-structure", { indicationCount: indications.length });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!r.ok) {
      const errJson = (await r.json().catch(() => ({}))) as any;
      logEnd("indication-structure", __t0, "error", { upstreamStatus: r.status });
      return res.status(r.status).json({ error: `API error (${r.status}): ${errJson?.error?.message || "unknown"}` });
    }
    const data = (await r.json()) as any;
    const rawText: string = data.content?.[0]?.text ?? "";

    // Extract the JSON (whitelist parse happens inside validateIndicationStructure).
    const match = rawText.match(/<structure_json>([\s\S]*?)<\/structure_json>/);
    let parsed: unknown = {};
    if (match) {
      try {
        parsed = JSON.parse(match[1].trim());
      } catch {
        parsed = "unparseable"; // → validator rejects a non-object and returns the all-independent base path
      }
    }

    // DETERMINISTIC validation gate — the LLM's raw output NEVER reaches the aggregation unvalidated.
    const result = validateIndicationStructure(parsed, indicationIds);

    // ── Module 4: the facilitator checker — audits the dependency RATIONALES (never the labels' effect).
    // Shared transport/gate/health markers (lib/elicitation-checker). Findings are folded into the
    // existing structure-flags rail (rendered + persisted by the UI already); a checker "high" renders
    // with the reject styling. Display-only — the validated relationships above are untouched.
    let checkerFlags: { code: string; severity: "reject" | "info"; message: string }[] = [];
    if (result.relationships.length) {
      const digest = result.relationships.map((rel) => {
        const a = result.assumptions.find((x) => x.id === rel.id);
        return `"${rel.id}": resolved ${rel.indicationRelationship}${a?.source === "default" ? " (DEMOTED by the validator)" : ""} — rationale: ${rel.rationale}`;
      }).join("\n");
      const demotions = result.flags.filter((f) => f.severity === "reject").map((f) => f.message).join("; ") || "none";
      const review = await runElicitationChecker({
        apiKey: anthropicKey,
        handlerStartMs: __t0,
        subjectLabel: "the dependency calls",
        allowedQuantities: ["relationship", "mechanism", "general"],
        prompt: `You are the FACILITATOR auditing an expert's indication-dependency calls for ${String(drug ?? "a drug asset")}${mechanism ? ` (mechanism: ${String(mechanism)})` : ""}. Audit each RATIONALE — never propose a different relationship; deterministic code already validated the structure.

Development context provided to the expert: ${String(summary ?? "(none)")}

The expert's resolved calls:
${digest}

Validator demotions already applied: ${demotions}

Report ONLY genuine issues (max 5):
1. INFERRED-not-STATED: a conditional/sequential rationale that cites no concrete program language ("likely gated", "appears to be an expansion") — inference dressed as fact.
2. Label↔rationale mismatch: a rationale describing pure TIMING under a conditional-on label, or a stated go-decision gate under sequential-after.
3. Missed stated dependency: the development context explicitly states a gate or staggering that the expert labeled independent.
4. Motivated structure: every call leaning the value-maximizing way (all independent) despite stated dependencies in the context.
5. Mechanism honesty: the context indicates the same target/mechanism as the lead but the call's rationale is silent about it.

Respond with STRICT JSON only:
{"findings":[{"quantity":"relationship|mechanism|general","severity":"high|medium|info","message":"one or two sentences, name the indication id"}]}
Empty findings array if everything is defensible.`,
      });
      checkerFlags = review.findings.map((f) => ({
        code: f.severity === "high" ? "elicitation-checker-high" : "elicitation-checker",
        severity: f.severity === "high" ? ("reject" as const) : ("info" as const),
        message: f.message,
      }));
      if (review.flags.length) console.warn("[indication-structure] checker gate flags:", review.flags.join(" | "));
    }

    // Return ONLY the validated relationships + flags + assumptions. No number. Cashflow computes downstream.
    logEnd("indication-structure", __t0, "ok", { relationships: result.relationships.length, checkerFindings: checkerFlags.length });
    return res.status(200).json({
      relationships: result.relationships,
      flags: [...result.flags, ...checkerFlags],
      assumptions: result.assumptions,
      rejected: result.rejected,
      explanation: rawText.replace(/<structure_json>[\s\S]*?<\/structure_json>/g, "").trim(),
    });
  } catch (e: any) {
    logEnd("indication-structure", __t0, "error", { msg: e?.message });
    return res.status(500).json({ error: e?.message || "indication-structure interpretation failed" });
  }
}
