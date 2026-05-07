import type { NextApiRequest, NextApiResponse } from "next";

type Msg = { role: "user" | "assistant" | "system"; content: string };

async function searchWeb(query: string, tavilyKey: string): Promise<string> {
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: "basic",
        max_results: 5,
      }),
    });
    if (!r.ok) return "";
    const data = await r.json();
    const results = (data.results || [])
      .map((r: any) => `- ${r.title}: ${r.content} (${r.url})`)
      .join("\n");
    return results;
  } catch {
    return "";
  }
}

function needsWebSearch(message: string): boolean {
  const triggers = [
    "latest", "recent", "current", "news", "approved", "approval", "fda",
    "trial", "phase", "study", "result", "data", "price", "market", "stock",
    "pipeline", "competitor", "deal", "acquisition", "partnership", "label",
    "indication", "who", "when", "what happened",
  ];
  const lower = message.toLowerCase();
  return triggers.some((t) => lower.includes(t));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, context } = req.body as { messages: Msg[]; context?: any };

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(200).json({
      message: "ANTHROPIC_API_KEY is not set. Add it to Vercel env vars then redeploy.",
    });
  }

  const tavilyKey = process.env.TAVILY_API_KEY;
  const lastUserMessage = [...(messages || [])].reverse().find((m) => m.role === "user")?.content || "";

  let searchContext = "";
  if (tavilyKey && needsWebSearch(lastUserMessage)) {
    const asset = context?.payload?.asset || context?.payload?.name || "";
    const query = asset ? `${asset} ${lastUserMessage}` : lastUserMessage;
    const results = await searchWeb(query, tavilyKey);
    if (results) {
      searchContext = `\n\nWeb search results for "${query}":\n${results}\n\nUse these results to inform your answer and cite the URLs.`;
    }
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

AUTO-VALUATION TRIGGER: If the user's message is asking you to value, model, analyze, or research a specific drug — or if they just type a drug/compound name with no existing asset loaded — include this tag at the very end of your response:
<auto-value drug="DRUG_NAME" sponsor="SPONSOR_IF_MENTIONED" phase="PHASE_IF_MENTIONED"/>
Use this when: user types a drug name, says "value X", "model X", "what's X worth", "analyze X", "run X for Y indication", or similar. Omit sponsor/phase attributes if not mentioned.
${hasAsset ? "An asset is already loaded — do NOT trigger auto-value unless the user is explicitly asking to switch to a different drug." : "No asset is loaded yet — if the user mentions any drug name or asks to value something, trigger auto-value."}

FIELD UPDATE CAPABILITY: If the user asks you to set, update, or suggest a value for any model field, include a JSON block at the END of your response:
<field-update>{"peakSales": 2000000000, "loeYear": 2031, "launchYear": 2027}</field-update>
Available fields: peakSales (USD — updates the first/active indication's peak sales when indications exist), discountRate (decimal e.g. 0.10 for 10%), cogsPct (decimal), taxRate (decimal), workingCapitalPct (decimal), avgRoyalty (decimal), launchYear (integer), loeYear (integer), devCostPV (USD), phase ("Preclinical"/"Phase 1"/"Phase 2"/"Phase 3"/"Filed"/"Approved"), ptrs (decimal 0–1), asset (string), indication (string), mechanism (string), sponsor (string).
Only include <field-update> when the user explicitly asks to change values.

Be concise and practical. Lead with the answer — one or two sentences max for factual questions. Cite web search URLs when available.${searchContext}`;

  const claudeMessages = (messages || []).map((m: Msg) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt,
        messages: claudeMessages,
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(200).json({ message: `Claude error: ${txt}` });
    }

    const data = await r.json();
    const raw = data?.content?.[0]?.text || "No response.";

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
