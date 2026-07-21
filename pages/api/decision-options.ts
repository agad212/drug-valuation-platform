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

  // Try to parse structured options from the response
  const result = parseAdvisorResponse(rawText);

  // If parsing failed on first attempt, RETRY with a corrective instruction
  if (result.options.length === 0 && !result.parseError) {
    // No options and no parse error means the model didn't emit the tags at all
    const retryMessages = [
      ...messages,
      { role: "assistant" as const, content: rawText },
      { role: "user" as const, content: "Your response did not include the required <options_json> block. Please emit the options as a JSON array inside <options_json>...</options_json> tags, followed by your explanation. This is required." },
    ];

    const r2 = await fetch("https://api.anthropic.com/v1/messages", {
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
        messages: retryMessages,
      }),
    });

    if (r2.ok) {
      const d2 = await r2.json() as any;
      const retryText: string = d2.content?.[0]?.text ?? "";
      const retryResult = parseAdvisorResponse(retryText);
      if (retryResult.options.length > 0) {
        return res.status(200).json(retryResult);
      }
    }

    // Both attempts failed — return clean error, no raw text
    return res.status(200).json({
      options: [],
      summary: "",
      parseError: "Couldn't generate structured options — please try rephrasing your question.",
    });
  }

  return res.status(200).json(result);
}

/**
 * Strip internal/reasoning tags that must never reach the UI.
 * Removes: <thinking>, <antThinking>, <artifact>, and any other
 * XML-like tags that contain model internal reasoning.
 */
function sanitizeOutput(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, "")
    .replace(/<artifact[\s\S]*?<\/artifact>/gi, "")
    // Catch unclosed thinking tags (model cut off mid-thought)
    .replace(/<thinking>[\s\S]*/gi, "")
    .replace(/<antThinking>[\s\S]*/gi, "")
    .trim();
}

/**
 * Parse the AI response: extract <options_json>, sanitize the summary,
 * never return raw internal reasoning.
 */
function parseAdvisorResponse(rawText: string): {
  options: any[];
  summary: string;
  parseError?: string;
} {
  const match = rawText.match(/<options_json>([\s\S]*?)<\/options_json>/);
  let options: any[] = [];
  let parseError: string | undefined;

  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      options = Array.isArray(parsed) ? parsed : [];
    } catch {
      parseError = "AI returned malformed option data — please try again.";
    }
  }

  // Summary = everything outside internal tags and the options block
  const summary = sanitizeOutput(
    rawText.replace(/<options_json>[\s\S]*?<\/options_json>/g, ""),
  );

  return { options, summary, parseError };
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

═══════════════════════════════
CRITICAL RULES — READ CAREFULLY
═══════════════════════════════

RULE 1 — EVERY OPTION MUST MODEL THE FULL COMMERCIAL PICTURE.
The engine computes eNPV = P(approval) × Revenue PV − Dev Cost for each option.
If you change the indication, target population, label scope, or competitive landscape:
  → You MUST set "peakSalesMOverride" to the estimated annual peak sales (in $M) for THAT option's market.
  → You MUST set "devCostMOverride" to the estimated total dev cost (in $M) if the program scope changes materially.
If you don't set these, the engine will use the baseline's $${ctx.peakSalesM?.toFixed(0) ?? "??"}M peak sales for ALL options, which is WRONG whenever the market opportunity changes.

RULE 2 — P(approval) IS COMPUTED BY THE ENGINE FROM YOUR STRUCTURED FIELDS. DO NOT hand it a number.
The engine RE-RUNS the real stage-by-stage probability model for each option using the STRUCTURED
design fields you set — the SAME engine the baseline and the what-if analysis use. Your job is to set
the fields that make the probability move in the right direction; the engine produces the number:
  - HARDER efficacy bar (must beat an ACTIVE control, not placebo/saline) → set "comparatorType":"active"
    (or "nullResponseRateOverride" to the control's known response rate). This LOWERS P(trial success).
  - BIOMARKER enrichment (cleaner, concentrated effect) → set "populationType":"biomarker_selected".
    This RAISES P(trial success). (Broadening to "broad" from a selected base LOWERS it.)
  - SAMPLE SIZE → set "n". Larger n → more power → higher P; smaller n → lower.
  - REGULATORY PATH → set "regulatoryContext" (e.g. losing "orphan" → "standard"). The engine applies
    the correct pathway effect.
  - ADDED INDICATIONS (breadth) → set "addedIndicationCount" (number of indications ADDED beyond the
    lead; a 2-indication platform → 1, a 3 → 2) and "addedIndicationsValidated" (true only if the added
    indications carry their own precedent). Breadth is NOT free: the engine LOWERS the blended program
    probability for each added, less-validated indication. A broad platform must never look as safe as
    the focused baseline.
Do NOT set "ptrsOverride" — it is a deprecated escape hatch the engine ignores whenever a dev plan
exists (it always does here). Express difficulty through the structured fields above and let the engine
compute P. Set fields HONESTLY (an active-comparator RCT is genuinely harder); do not reverse-engineer a
desired probability.

RULE 3 — "changesSummary" IS REQUIRED ON EVERY NON-BASELINE OPTION.
Each non-baseline option must include a "changesSummary" string field: one QUALITATIVE line listing what changed and why.
CRITICAL: do NOT quote specific P(approval), dev-cost, eNPV, or peak-sales NUMBERS in changesSummary. The
engine computes those and displays them on the option cards; any number you write here will CONTRADICT the
card (your ptrsOverride/devCostMOverride are inputs the engine may override). Describe the change and its
DIRECTION only.
Example: "changesSummary": "Larger indication (AMD), n 40→400, RCT hard endpoint, lost orphan status — broader market but a harder regulatory bar." (No numbers.)

RULE 4 — Option A (first element) MUST always be the baseline with "isBaseline": true and NO parameter overrides.

RULE 5 — Only set fields that CHANGE from the baseline — leave everything else out.

RULE 6 — Be realistic. Think like a pharma executive, not an optimizer.
  - Out-licensing: isOutlicensed + royaltyPctOverride (0–1)
  - VOI studies: isVOI:true with voiCostM, voiMonths, voiProbPositive
  - Biomarker selection: populationType:"biomarker_selected" + smaller n + inclusionCriteria:"tight"
  - Active-comparator head-to-head: comparatorType:"active" (harder bar → engine lowers P)
  - Indication expansion / parallel programs: set addedIndicationCount (+ peakSalesMOverride for the
    COMBINED market, devCostMOverride for the COMBINED cost). The engine lowers the blended program P
    for the added breadth — do NOT expect a bigger market to come with the same probability.

═══════════════════════════════
FULL OPTION SCHEMA
═══════════════════════════════

{
  "id": string,                    // short unique ID, e.g. "opt-b"
  "name": string,                  // descriptive name, e.g. "Pivot to AMD — Full RCT"
  "isBaseline": boolean,           // true ONLY for Option A
  "changesSummary": string,        // REQUIRED on non-baseline: one line of what changed and why

  // ── Trial design (THE ENGINE RECOMPUTES P(approval) FROM THESE) ──
  "n": number,                     // sample size
  "endpointType": "hard" | "surrogate" | "pro",
  "designType": "rct" | "single_arm" | "basket",
  "numArms": 1 | 2 | 3 | "adaptive",
  "populationType": "broad" | "biomarker_selected" | "rare_small",
  "inclusionCriteria": "tight" | "standard" | "broad",
  "placeboResponse": "low" | "moderate" | "high",
  "regulatoryContext": "standard" | "btd" | "orphan" | "btd_orphan" | "accelerated" | "confirmatory",
  "comparatorType": "placebo" | "active",   // "active" = harder bar (beat an active SOC) → lower P
  "nullResponseRateOverride": number,        // 0-1: explicit control response rate (active comparator)
  "addedIndicationCount": number,            // indications ADDED beyond the lead (breadth → lower blended P)
  "addedIndicationsValidated": boolean,      // true only if added indications carry their own precedent

  // ── Commercial overrides (CRITICAL — set whenever the market changes) ──
  "peakSalesMOverride": number,    // annual peak sales in $M for THIS option's market
  "devCostMOverride": number,      // total dev cost in $M if program scope changes
  "ptrsOverride": number,          // DEPRECATED — ignored when a dev plan exists; do NOT use for probability

  // ── Partnership ──
  "ownershipPct": number,          // 0-100
  "isOutlicensed": boolean,
  "royaltyPctOverride": number,    // 0-1

  // ── VOI ──
  "isVOI": boolean,
  "voiCostM": number,
  "voiMonths": number,
  "voiProbPositive": number,       // 0-1
  "voiPtrsBoostIfPositive": number // absolute boost, e.g. 0.10
}

═══════════════════════════════
EXAMPLE
═══════════════════════════════

User asks about KIO-301 indication expansion from RP (orphan) to larger retinal indication:
<options_json>
[
  {"id":"opt-a","name":"RP Orphan Path (Current)","isBaseline":true},
  {"id":"opt-b","name":"Pivot to AMD — Single Arm","n":180,"designType":"single_arm","endpointType":"surrogate","regulatoryContext":"standard","peakSalesMOverride":1200,"devCostMOverride":180,"changesSummary":"Pivoted to AMD (larger market). Lost orphan status → standard pathway. Single-arm surrogate in a non-rare setting. Broader market, harder bar."},
  {"id":"opt-c","name":"Pivot to AMD — Active-Comparator RCT","n":400,"designType":"rct","endpointType":"hard","regulatoryContext":"standard","placeboResponse":"moderate","comparatorType":"active","peakSalesMOverride":1400,"devCostMOverride":350,"changesSummary":"Full RCT vs an active control in AMD. Credible but must beat an efficacious comparator — a harder efficacy bar. Larger market, higher cost."},
  {"id":"opt-d","name":"RP + AMD Parallel Track","n":400,"designType":"rct","endpointType":"hard","regulatoryContext":"standard","addedIndicationCount":1,"peakSalesMOverride":1750,"devCostMOverride":500,"changesSummary":"Run both RP (beachhead) and AMD (expansion) — one added, less-validated indication. Combined market and cost; breadth carries a lower blended program probability."}
]
</options_json>

After the JSON block, explain each option and its key trade-offs QUALITATIVELY. Be direct, but:
- Do NOT state specific P(approval), dev-cost, eNPV, or peak-sales numbers, and do NOT build a summary
  table of them. The engine computes those and shows them on the cards; any number you write will
  contradict the cards. Refer the reader to the cards for exact figures and describe DIRECTION and
  reasoning only ("broader label, higher market, but a harder regulatory bar").
- If two options have the SAME trial design (e.g. an expansion whose pivotal is identical to another
  option's), say so plainly — "these compute identically in-model; the expansion's value is post-approval
  and not captured here." Do NOT invent a blended probability or combined peak-sales figure to make them
  look different.
- Do NOT declare a single recommended option with numbers — the app marks the highest-eNPV option from the
  engine. You may discuss which strategy fits which goal, qualitatively.`;
}
