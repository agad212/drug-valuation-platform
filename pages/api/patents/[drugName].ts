import type { NextApiRequest, NextApiResponse } from "next";

// ─── Search Google Patents via Tavily ─────────────────────────────────────────

async function searchGooglePatents(drugName: string, sponsor?: string) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error("TAVILY_API_KEY not set");

  // Two targeted queries: compound patents + general drug patents
  const queries = [
    `"${drugName}" compound patent composition filing date expiry${sponsor ? ` "${sponsor}"` : ""}`,
    `"${drugName}" patent formulation method-of-use${sponsor ? ` "${sponsor}"` : ""}`,
  ];

  const allResults: any[] = [];

  for (const query of queries) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: "basic",
          include_domains: ["patents.google.com", "lens.org", "worldwide.espacenet.com"],
          max_results: 7,
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      allResults.push(...(data.results || []));
    } catch { continue; }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return allResults.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// ─── Claude analysis ──────────────────────────────────────────────────────────

async function analyzeWithClaude(drugName: string, sponsor: string | undefined, results: any[]) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const resultList = results.map((r, i) => {
    // Extract patent number from Google Patents URL
    const numMatch = r.url?.match(/patent\/([A-Z]{2}[\w]+)/);
    const patentNum = numMatch ? numMatch[1] : "unknown";
    return `[${i + 1}] ${patentNum}
Title: ${r.title || "N/A"}
URL: ${r.url || ""}
Snippet: ${(r.content || "").slice(0, 500)}`;
  }).join("\n\n");

  const systemPrompt = `You are a pharmaceutical patent analyst estimating Loss of Exclusivity (LOE) from patent search results.

Patent hierarchy for LOE (most to least important):
1. Compound/composition patents — cover the active molecule (critical, longest protection)
2. Formulation patents — specific delivery systems
3. Method-of-use patents — therapeutic indications
4. Process patents — manufacturing (least relevant for LOE)

LOE estimation rules:
- US/EU patents: 20 years from earliest filing date
- Patent Term Extension (PTE): up to 5 extra years in the US for FDA regulatory delay (common for biologics/NCEs)
- Typical compound patent LOE = filing year + 20–25 years
- Pipeline drugs often have compound patents filed 5–15 years before approval

Extract filing years from the snippets where possible (look for "filed", "application", "priority date", year patterns).

Respond ONLY with valid JSON, no text outside it:
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

Google Patents search results (${results.length} found):

${resultList}

Analyze these patents and estimate the LOE range.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) throw new Error(`Claude error: ${res.status}`);
  const data = await res.json();
  const text = data?.content?.[0]?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drugName = String(req.query.drugName || "").trim();
  const sponsor = req.query.sponsor ? String(req.query.sponsor).trim() : undefined;

  if (!drugName) return res.status(400).json({ error: "Drug name required" });

  let results: any[] = [];
  try {
    results = await searchGooglePatents(drugName, sponsor);
  } catch (e: any) {
    return res.status(200).json({
      found: 0, loeMin: null, loeMax: null, bestEstimate: null,
      confidence: "low", keyPatents: [], reasoning: `Patent search failed: ${e?.message}`, caveats: [],
    });
  }

  if (results.length === 0) {
    return res.status(200).json({
      found: 0, loeMin: null, loeMax: null, bestEstimate: null, confidence: "low",
      keyPatents: [],
      reasoning: `No patents found for "${drugName}"${sponsor ? ` / "${sponsor}"` : ""}. Try without a sponsor name, or check spelling.`,
      caveats: [],
    });
  }

  try {
    const analysis = await analyzeWithClaude(drugName, sponsor, results);
    return res.status(200).json({ found: results.length, ...analysis });
  } catch (e: any) {
    return res.status(200).json({
      found: results.length, loeMin: null, loeMax: null, bestEstimate: null,
      confidence: "low", keyPatents: [],
      reasoning: `Found ${results.length} patents but AI analysis failed: ${e?.message}`,
      caveats: [],
    });
  }
}
