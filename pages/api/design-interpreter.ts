// /api/design-interpreter — LAYER 2 endpoint.
//
// Maps a free-form trial-design request to a STRUCTURED spec via the LLM, then runs it through the
// DETERMINISTIC validator (lib/trial-design-interpreter). Returns { spec, flags, assumptions } — NEVER
// a power / P(approval) / eNPV number. Those are Layer-1's output, computed downstream from this spec.
//
// NO-LEAK: this endpoint imports ONLY the interpreter/validator — no Layer-1 power function. The LLM
// emits design PARAMETERS; the validator whitelists them (any hallucinated numeric result is dropped).

import type { NextApiRequest, NextApiResponse } from "next";
import { validateDesignSpec } from "../../lib/trial-design-interpreter";
import { logStart, logEnd } from "../../lib/endpoint-timing";

const SYSTEM_PROMPT = `You translate a free-form clinical-trial DESIGN description into a STRUCTURED JSON spec.
You SPECIFY the design; deterministic code downstream COMPUTES the statistics.

ABSOLUTE RULE: NEVER emit power, P(approval), probability of success, eNPV, ROI, or ANY computed
number. Emit ONLY the design parameters below. If you write a "power"/"pApproval"/"eNPV" field it will
be discarded — those are computed by the engine from your spec, not by you.

Emit ONE JSON object inside <spec_json>...</spec_json>. Fields (all optional; omit what isn't stated):
  "n": number (sample size)
  "designType": "rct" | "single_arm" | "basket"
  "endpointType": string (e.g. "surrogate","hard")
  "populationType": string (e.g. "broad","biomarker_selected")
  "regulatoryContext": "standard"|"fast_track"|"btd"|"orphan"|"btd_orphan"|"accelerated"|"confirmatory"
  "nullResponseRate": number in (0,1)
  "isTimeToEvent": boolean
  "alpha": { "value": number in (0,0.5), "sided": 1|2, "multiplicity"?: number }   // free significance level
  "continuous": { "outcomeSd": number>0, "expectedDelta": number>0 }               // native two-sample z
  "tte": { "expectedHR": number>0 (≠1), "events"?: number>0,
           "accrual"?: { "controlMedianMonths":number,"accrualMonths":number,"followupMonths":number,"dropoutHazardPerMonth"?:number,"nTotal":number } }
  "sequential": { "lookFractions": number[] in (0,1] strictly increasing,
                  "spending"?: "OBF"|"POCOCK",
                  "futility"?: { "futilityType":"beta-spending"|"conditional-power"|"none","binding"?:boolean,"beta"?:number,"spending"?:"OBF"|"POCOCK" } }
  "bayesian": { "refTheta": number in (0,1), "postThreshold": number in (0,1), "analysisPrior"?: { "a":number,"b":number } }
  "stageTarget": "Phase 2" | "Phase 3" | "pivotal" | <0-based stage index>   // WHICH trial the design addresses
  "unsupported": string   // name a requested design family this schema CANNOT represent, so the engine flags it

RESOLVE-OR-FLAG:
- State a value only if the user gave it or it is directly derivable. Do NOT invent an effect anchor:
  if an expected HR / SD+Δ / reference rate (θ₀) is not stated, OMIT that family (the engine flags it) — never guess it.
- Leave structural knobs (spending shape, number of looks, binding) unstated if the user didn't say —
  the engine fills a LABELED default you'll see; don't guess them either.

STAGE-TARGET (WHICH trial the design addresses — populate it from the language; do NOT leave it to a guess):
- "Phase 2" / "P2" / "the Phase 2" → stageTarget: "Phase 2".   "Phase 3" → "Phase 3".
- "pivotal" / "registration" / "the pivotal trial" / "confirmatory trial" → stageTarget: "pivotal".
- If the user names NO stage → OMIT stageTarget (the engine defaults to the pivotal/registration stage and
  SURFACES that as an assumption). Do NOT emit a guessed stage.
  e.g. "power the Phase 2 as a survival study …" → stageTarget: "Phase 2" (NOT pivotal).

FUTILITY IS A GROUP-SEQUENTIAL STRUCTURE: a futility rule/interim cannot exist without a sequential design. If
the user asks for a futility rule/interim, emit a "sequential" block WITH the "futility" block — never an empty
spec. e.g. "add a futility rule" → "sequential": { "futility": { "futilityType": "beta-spending" } } (the engine
defaults + surfaces the look schedule).

UNSUPPORTED — CARRY, never silently drop: if the user requests a family this schema cannot represent (adaptive /
sample-size re-estimation / arm-dropping, Bayesian predictive-probability, conditional-power futility, single-arm
or basket time-to-event), set "unsupported" to name it (e.g. "unsupported": "adaptive sample-size re-estimation").
Still emit the closest supported spec. NEVER silently return a plain design — the engine flags "unsupported" so the
user sees BOTH that it isn't computable yet AND what was computed instead.

LOOK FRACTIONS — emit in the ORDER the user gave; do NOT silently reorder. If the user lists interim looks
descending or out of order, emit them as given (the engine rejects a non-monotonic schedule and says why). Never
quietly sort them into a valid order — that hides a possible mistake and silently drives the number.`;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { request } = req.body ?? {};
  if (!request || typeof request !== "string") return res.status(400).json({ error: "request (string) required" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const __t0 = logStart("design-interpreter");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: request }],
      }),
    });
    if (!r.ok) {
      const errJson = (await r.json().catch(() => ({}))) as any;
      logEnd("design-interpreter", __t0, "error", { upstreamStatus: r.status });
      return res.status(r.status).json({ error: `API error (${r.status}): ${errJson?.error?.message || "unknown"}` });
    }
    const data = (await r.json()) as any;
    const rawText: string = data.content?.[0]?.text ?? "";

    // Extract the JSON spec (whitelist parse happens inside validateDesignSpec).
    const match = rawText.match(/<spec_json>([\s\S]*?)<\/spec_json>/);
    let parsed: unknown = {};
    if (match) {
      try {
        parsed = JSON.parse(match[1].trim());
      } catch {
        // fall through → validateDesignSpec will reject a non-object and return the base path
        parsed = "unparseable";
      }
    }

    // DETERMINISTIC validation gate — the LLM's raw output NEVER reaches Layer 1 unvalidated.
    const result = validateDesignSpec(parsed);

    // Return ONLY the validated spec + flags + assumptions. No number. Layer 1 computes downstream.
    logEnd("design-interpreter", __t0, "ok");
    return res.status(200).json({
      spec: result.spec,
      flags: result.flags,
      assumptions: result.assumptions,
      rejected: result.rejected,
      explanation: rawText.replace(/<spec_json>[\s\S]*?<\/spec_json>/g, "").trim(),
    });
  } catch (e: any) {
    logEnd("design-interpreter", __t0, "error", { msg: e?.message });
    return res.status(500).json({ error: e?.message || "design interpretation failed" });
  }
}
