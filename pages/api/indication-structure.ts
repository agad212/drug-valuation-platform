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

const SYSTEM_PROMPT = `You classify how the NON-LEAD indications of a single drug asset relate to the lead
indication (or to each other), for a risk-adjusted valuation. You SPECIFY the STRUCTURE; deterministic
code downstream COMPUTES every number from it.

ABSOLUTE RULE: NEVER emit a probability, P(approval), peak sales, revenue, eNPV, ROI, weight, or ANY
number. There is no numeric field. If you write one it is discarded — the engine computes all numbers
from your structure, not you. You choose ONLY a relationship label + a prerequisite reference + a reason.

Emit ONE JSON object inside <structure_json>...</structure_json>:
  { "relationships": [ { "id": <indication id>, "relationship": "independent" | "conditional-on" | "sequential-after", "ref": <prerequisite indication id> | null, "rationale": <one short line> } ] }

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
- AMBIGUOUS / no signal → "independent" with a rationale saying so (e.g. "no stated dependency —
  defaulting to independent"). Do NOT guess conditional/sequential when unsure: independent is the
  transparent default, and guessing a dependency silently moves the valuation. Never invent a program
  strategy that isn't supported by the evidence.
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

    // Return ONLY the validated relationships + flags + assumptions. No number. Cashflow computes downstream.
    return res.status(200).json({
      relationships: result.relationships,
      flags: result.flags,
      assumptions: result.assumptions,
      rejected: result.rejected,
      explanation: rawText.replace(/<structure_json>[\s\S]*?<\/structure_json>/g, "").trim(),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "indication-structure interpretation failed" });
  }
}
