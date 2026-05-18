import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../../lib/claudeSearch";

// ─── Claude patent analysis with native web search ────────────────────────────

async function analyzeWithClaude(drugName: string, sponsor: string | undefined) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const systemPrompt = `You are a pharmaceutical patent analyst estimating Loss of Exclusivity (LOE).

Use web_search to find patents for this drug on patents.google.com, lens.org, and worldwide.espacenet.com.

Patent hierarchy for LOE (most to least important):
1. Compound/composition patents — cover the active molecule (critical, longest protection)
2. Formulation patents — specific delivery systems
3. Method-of-use patents — therapeutic indications
4. Process patents — manufacturing (least relevant for LOE)

LOE estimation rules:
- US/EU patents: 20 years from earliest filing date
- Patent Term Extension (PTE): up to 5 extra years in the US for FDA regulatory delay
- Typical compound patent LOE = filing year + 20–25 years

Respond ONLY with valid JSON:
{
  "loeMin": <integer year, conservative — no PTE>,
  "loeMax": <integer year, optimistic — with full PTE on key patents>,
  "bestEstimate": <integer year, most likely LOE>,
  "confidence": "high" | "medium" | "low",
  "keyPatents": [
    {
      "number": "<patent number e.g. US9073994B2>",
      "title": "<title>",
      "url": "<google patents URL>",
      "type": "compound" | "formulation" | "method-of-use" | "process" | "other",
      "filingYear": <integer or null>,
      "baseExpiry": <filing year + 20 or null>,
      "estimatedExpiry": <with PTE if applicable, or null>,
      "relevance": "high" | "medium" | "low",
      "reason": "<one sentence>"
    }
  ],
  "reasoning": "<2-4 sentences plain English explaining the LOE range>",
  "caveats": ["<caveat 1>", "<caveat 2>"]
}`;

  const userMessage = `Drug: ${drugName}${sponsor ? `\nSponsor: ${sponsor}` : ""}

Search for patents on patents.google.com, lens.org, and espacenet.com, then analyze and estimate the LOE range.`;

  const text = await callClaudeWithSearch({
    anthropicKey,
    system: systemPrompt,
    userMessage,
    maxTokens: 2000,
    maxSearches: 4,
    serperQueries: [
      `${drugName} patent expiry loss of exclusivity`,
      `${drugName} compound patent site:patents.google.com`,
    ],
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drugName = String(req.query.drugName || "").trim();
  const sponsor = req.query.sponsor ? String(req.query.sponsor).trim() : undefined;

  if (!drugName) return res.status(400).json({ error: "Drug name required" });

  try {
    const analysis = await analyzeWithClaude(drugName, sponsor);
    return res.status(200).json({ found: analysis.keyPatents?.length || 0, ...analysis });
  } catch (e: any) {
    return res.status(200).json({
      found: 0, loeMin: null, loeMax: null, bestEstimate: null,
      confidence: "low", keyPatents: [],
      reasoning: `Patent analysis failed: ${e?.message}`,
      caveats: [],
    });
  }
}
