import type { NextApiRequest, NextApiResponse } from "next";

type Msg = { role: "user" | "assistant" | "system"; content: string };


export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, context } = req.body as { messages: Msg[]; context?: any };

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(200).json({
      message: "ANTHROPIC_API_KEY is not set. Add it to Vercel env vars then redeploy.",
    });
  }

  const hasAsset = !!(context?.payload?.asset || context?.payload?.name);

  // Extract key computed outputs to surface explicitly to Claude
  const payload = context?.payload || {};
  const rnpv = payload.rnpv != null ? `$${(payload.rnpv / 1e9).toFixed(2)}B` : "—";
  const revenuePV = payload.revenuePV != null ? `$${(payload.revenuePV / 1e9).toFixed(2)}B` : "—";
  const ptrsVal = payload.ptrs != null ? `${(payload.ptrs * 100).toFixed(1)}%` : "—";
  const devCostPV = payload.devCostPV != null ? `$${(payload.devCostPV / 1e6).toFixed(0)}M` : "—";
  const discountRate = payload.discountRate != null ? `${(payload.discountRate * 100).toFixed(1)}%` : "—";
  const indications = (payload.indications || []).map((ind: any) =>
    `  - ${ind.name}: peak $${((ind.peakSales||0)/1e6).toFixed(0)}M, launch ${ind.launchYear||"—"}, LOE ${ind.loeYear||"—"}, PTRS ${((ind.ptrs ?? payload.ptrs ?? 0)*100).toFixed(0)}%, devCost $${((ind.devCostPV||0)/1e6).toFixed(0)}M`
  ).join("\n");

  const systemPrompt = `You are the DrugValue assistant — an AI-powered pharmaceutical asset valuation tool. You build rNPV models, explain valuation drivers, and help refine assumptions through conversation.

CRITICAL: The current valuation has already been computed. When the user asks for rNPV, PTRS, Revenue PV, or any other metric — READ IT FROM THE CONTEXT BELOW. Do NOT recalculate or estimate. Quote the exact number from context.

CURRENT COMPUTED VALUES (read these exactly — do not recalculate):
  rNPV: ${rnpv}
  Revenue PV: ${revenuePV}
  PTRS: ${ptrsVal}
  Dev Cost PV: ${devCostPV}
  Discount Rate: ${discountRate}
  Asset: ${payload.asset || "—"}
  Phase: ${payload.phase || "—"}
  Sponsor: ${payload.sponsor || "—"}
  Mechanism: ${payload.mechanism || "—"}
  LOE Year: ${payload.loeYear || "—"}
  Launch Year: ${payload.launchYear || "—"}

INDICATIONS:
${indications || "  None loaded"}

AUTO-VALUATION TRIGGER — ABSOLUTE RULE, NO EXCEPTIONS:
If the user's message looks like a drug or compound name, you MUST emit the auto-value tag. ALWAYS. No matter what.
- Even if web search found nothing
- Even if you don't recognize the name
- Even if it could be a typo
- Even if it looks like an internal code

The downstream pipeline handles unknown/obscure/pre-IND compounds. YOUR JOB is only to detect the intent and pass it through. Never ask for clarification on a drug name input.

Include this tag at the very end of your response (say "On it! Looking up X now." and nothing else):
<auto-value drug="DRUG_NAME" sponsor="SPONSOR_IF_MENTIONED" phase="PHASE_IF_KNOWN"/>
IMPORTANT: Only include phase= if you are CERTAIN (e.g. user explicitly said "Phase 2" or drug is obviously approved like pembrolizumab). For unknown or newly announced drugs, OMIT the phase attribute entirely.
Trigger when: user types 1–4 words with no question mark and no existing asset loaded, says "value X", "model X", "what's X worth", "analyze X", "run X", or anything that looks like a drug/compound/asset name. When in doubt, always trigger.
${hasAsset ? "An asset is already loaded — do NOT trigger auto-value unless the user is explicitly asking to switch to a different drug." : "No asset is loaded yet — treat any short message (1–4 words, no question mark) as a drug name and trigger auto-value immediately without asking questions."}

FIELD UPDATE CAPABILITY: If the user asks you to set, update, or suggest a value for any model field, include a JSON block at the END of your response:
<field-update>{"peakSales": 2000000000, "loeYear": 2031, "launchYear": 2027}</field-update>
Available fields: peakSales (USD — updates the first/active indication's peak sales when indications exist), discountRate (decimal e.g. 0.10 for 10%), cogsPct (decimal), taxRate (decimal), workingCapitalPct (decimal), avgRoyalty (decimal), launchYear (integer), loeYear (integer), devCostPV (USD), phase ("Preclinical"/"Phase 1"/"Phase 2"/"Phase 3"/"Filed"/"Approved"), ptrs (decimal 0–1), asset (string), indication (string), mechanism (string), sponsor (string).
Only include <field-update> when the user explicitly asks to change values.

Be concise and practical. Lead with the answer — one or two sentences max for factual questions. Use web_search when you need current data. Cite URLs when available.`;

  const claudeMessages: any[] = (messages || []).map((m: Msg) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  try {
    // web_search_20250305 is server-side — Anthropic executes searches automatically
    // within a single API call. No manual loop needed.
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: claudeMessages,
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      let friendlyMsg = "Claude is temporarily unavailable. Please try again in a moment.";
      try {
        const errJson = JSON.parse(txt);
        const errType = errJson?.error?.type;
        console.error("[chat] Anthropic API error:", r.status, errType, txt.slice(0, 300));
        if (errType === "overloaded_error") friendlyMsg = "Claude is overloaded right now. Please try again in a few seconds.";
        else if (errType === "rate_limit_error") friendlyMsg = "Rate limit reached. Please wait a moment and try again.";
        else if (errType === "authentication_error") friendlyMsg = "API key error — check ANTHROPIC_API_KEY in Vercel env vars.";
      } catch { console.error("[chat] Anthropic API error (unparseable):", r.status, txt.slice(0, 300)); }
      return res.status(200).json({ message: friendlyMsg });
    }

    const data = await r.json();
    const content: any[] = data.content || [];
    const raw = content.filter((c) => c.type === "text").map((c) => c.text).join("") || "No response.";

    // Parse field-update block
    const fieldUpdateMatch = raw.match(/<field-update>([\s\S]*?)<\/field-update>/);
    let fieldUpdates: Record<string, any> | null = null;
    let message = raw.replace(/<field-update>[\s\S]*?<\/field-update>/g, "").trim();
    if (fieldUpdateMatch) {
      try { fieldUpdates = JSON.parse(fieldUpdateMatch[1].trim()); } catch { /* ignore */ }
    }

    // Parse auto-value trigger
    const avMatch = message.match(/<auto-value([^/]*)\/?>/);
    let autoValueTrigger: { drug: string; sponsor?: string; phase?: string } | null = null;
    if (avMatch) {
      message = message.replace(/<auto-value[^>]*\/?>/g, "").trim();
      const drugMatch = avMatch[1].match(/drug="([^"]+)"/);
      const sponsorMatch = avMatch[1].match(/sponsor="([^"]+)"/);
      const phaseMatch = avMatch[1].match(/phase="([^"]+)"/);
      if (drugMatch?.[1]) {
        autoValueTrigger = {
          drug: drugMatch[1],
          sponsor: sponsorMatch?.[1] || undefined,
          phase: phaseMatch?.[1] || undefined,
        };
      }
    }

    return res.status(200).json({ message, fieldUpdates, autoValueTrigger });
  } catch (e: any) {
    return res.status(200).json({ message: `Server error: ${e?.message || "unknown"}` });
  }
}
