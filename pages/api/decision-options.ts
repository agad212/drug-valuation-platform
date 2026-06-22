// ─── Decision Options API ─────────────────────────────────────────────────────
//
// POST /api/decision-options
//
// Receives a natural-language strategy question (plus drug context) and returns
// a structured OptionInputs[] array for use in the Decision Analysis engine,
// along with a plain-language explanation. The caller still runs computeDevPlan
// per option locally (no server-side computation).
//
// ─────────────────────────────────────────────────────────────────────────────

import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const { message, context, history = [] } = req.body as {
    message: string;
    context: StrategyContext;
    history?: { role: "user" | "assistant"; content: string }[];
  };

  if (!message?.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const systemPrompt = buildSystemPrompt(context);

  // Build message history (keep last 6 turns to avoid bloating context)
  const recentHistory = history.slice(-6);
  const messages = [
    ...recentHistory,
    { role: "user" as const, content: message },
  ];

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    }),
  });

  if (!r.ok) {
    const errJson = await r.json().catch(() => ({})) as any;
    const errMsg = errJson?.error?.message ?? "";
    if (errMsg.toLowerCase().includes("credit balance")) {
      return res.status(402).json({ error: "API credits are out — go to console.anthropic.com → Plans & Billing to top up." });
    }
    return res.status(r.status).json({ error: `API error (${r.status}): ${errMsg || "unknown"}` });
  }

  const data = await r.json() as any;
  const rawText: string = data.content?.[0]?.text ?? "";

  // Extract <options_json>[...]</options_json>
  const match = rawText.match(/<options_json>([\s\S]*?)<\/options_json>/);
  let options: any[] = [];
  let parseError: string | undefined;

  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      options = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      parseError = "AI returned malformed JSON — please try again.";
    }
  } else {
    parseError = "AI response did not include structured options — please try again.";
  }

  // Summary = everything outside the <options_json> block
  const summary = rawText
    .replace(/<options_json>[\s\S]*?<\/options_json>/g, "")
    .trim();

  return res.status(200).json({
    options,
    summary,
    assistantMessage: rawText,
    parseError,
  });
}

// ─── Context type (subset of valuation state sent from client) ────────────────

type StageCtx = {
  name: string;
  phase: string;
  n: number;
  cpp: number;
  endpointType: string;
  designType: string;
  populationType: string;
  trialSuccessProb: number;
  durationMonths: number;
};

type StrategyContext = {
  asset?: string;
  phase?: string;
  mechanism?: string;
  indication?: string;
  pApproval?: number;       // 0-1, overall P(approval) from devPlan
  peakSalesM?: number;
  eNPVM?: number;
  devCostM?: number;
  effectShape?: "unimodal" | "bimodal";
  stages?: StageCtx[];
  currentDesign?: {
    n: number;
    endpointType: string;
    designType: string;
    populationType: string;
    regulatoryContext: string;
    placeboResponse: string;
  };
};

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx: StrategyContext): string {
  const pct = (n?: number) => n != null ? `${(n * 100).toFixed(1)}%` : "unknown";
  const usd = (n?: number) => n != null ? `$${n.toFixed(0)}M` : "unknown";

  const stagesText = ctx.stages?.length
    ? ctx.stages
        .map((s, i) =>
          `  ${i + 1}. ${s.name} (${s.phase}): n=${s.n}, ${s.designType}, ` +
          `${s.endpointType} endpoint, P(success)=${pct(s.trialSuccessProb)}, ` +
          `~${s.durationMonths}mo, $${(s.n * s.cpp / 1e6).toFixed(1)}M`
        )
        .join("\n")
    : "  (no staged plan yet)";

  const designText = ctx.currentDesign
    ? `Design: ${ctx.currentDesign.designType}, n=${ctx.currentDesign.n}, ` +
      `${ctx.currentDesign.endpointType} endpoint, ${ctx.currentDesign.populationType} population, ` +
      `${ctx.currentDesign.regulatoryContext} pathway, ${ctx.currentDesign.placeboResponse} placebo response`
    : "(design unknown)";

  return `You are a pharmaceutical development strategy advisor embedded in DrugValue, a drug asset valuation platform.

Your role: when a user describes strategic alternatives for a drug program, you generate 2-4 concrete, comparable options as a structured JSON array — then explain the trade-offs in plain English.

═══════════════════════════════
CURRENT DRUG CONTEXT
═══════════════════════════════
Asset:          ${ctx.asset ?? "Unknown"}
Phase:          ${ctx.phase ?? "Unknown"}
Mechanism:      ${ctx.mechanism ?? "Unknown"}
Indication:     ${ctx.indication ?? "Unknown"}
P(approval):    ${pct(ctx.pApproval)}
Peak Sales:     ${usd(ctx.peakSalesM)}
Expected NPV:   ${usd(ctx.eNPVM)}
Total Dev Cost: ${usd(ctx.devCostM)}
Evidence shape: ${ctx.effectShape ?? "unknown"}${ctx.effectShape === "bimodal" ? " ← coin-flip between two outcome scenarios" : ""}

CURRENT BASE TRIAL DESIGN:
${designText}

DEVELOPMENT STAGES:
${stagesText}

═══════════════════════════════
HOW TO RESPOND
═══════════════════════════════

Step 1: Emit a JSON array inside <options_json> tags. This MUST be valid JSON.
Step 2: After the closing tag, write your plain-language explanation.

RULES FOR THE JSON:
• Option A (first element) MUST always be the baseline with "isBaseline": true and NO parameter overrides.
• Generate 1–3 additional options based on what the user is asking.
• Only set fields that CHANGE from the baseline — leave everything else out.
• Be realistic: changes should reflect actual clinical trial design decisions.
• If the user asks about out-licensing, use isOutlicensed + royaltyPctOverride (0–1).
• If a VOI study makes sense, set isVOI:true with voiCostM, voiMonths, voiProbPositive.
• For biomarker selection: use populationType:"biomarker_selected" AND reduce n accordingly (biomarker-selected trials are typically smaller).

FULL OPTION SCHEMA (all fields optional except id, name):
{
  "id": string,                  // short unique ID, e.g. "opt-b"
  "name": string,                // descriptive name, e.g. "Biomarker-Selected Phase 2"
  "isBaseline": boolean,         // true ONLY for Option A
  "n": number,                   // sample size
  "endpointType": "hard" | "surrogate" | "pro",
  "designType": "rct" | "single_arm" | "basket",
  "numArms": 1 | 2 | 3 | "adaptive",
  "populationType": "broad" | "biomarker_selected" | "rare_small",
  "inclusionCriteria": "tight" | "standard" | "broad",
  "placeboResponse": "low" | "moderate" | "high",
  "regulatoryContext": "standard" | "btd" | "orphan" | "btd_orphan" | "accelerated" | "confirmatory",
  "ownershipPct": number,        // 0-100, e.g. 50 for 50/50 co-dev
  "isOutlicensed": boolean,      // true = royalty model
  "royaltyPctOverride": number,  // 0-1, e.g. 0.12 for 12% royalty
  "isVOI": boolean,              // true = run a smaller study first, then decide
  "voiCostM": number,            // VOI study cost in $M
  "voiMonths": number,           // months of delay from VOI
  "voiProbPositive": number,     // 0-1, P(small study reads out positive)
  "voiPtrsBoostIfPositive": number  // absolute boost to P(approval) if positive, e.g. 0.10
}

EXAMPLE (biomarker vs broad vs out-license):
<options_json>
[
  {"id":"opt-a","name":"Current Plan","isBaseline":true},
  {"id":"opt-b","name":"Biomarker-Selected Phase 2","n":90,"populationType":"biomarker_selected","inclusionCriteria":"tight","endpointType":"hard"},
  {"id":"opt-c","name":"Broad Population RCT","n":250,"populationType":"broad","designType":"rct","inclusionCriteria":"broad"},
  {"id":"opt-d","name":"Out-License to Partner","isOutlicensed":true,"royaltyPctOverride":0.14}
]
</options_json>

After the tag, explain what each option represents, the key trade-offs (P(approval) vs cost vs time vs revenue), and your recommendation given this drug's profile. Use plain language — no jargon. Be direct.`;
}
