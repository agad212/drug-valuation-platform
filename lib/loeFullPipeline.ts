import { inferLOE } from "./loeAdapter";

// ─── Google Patents search via Tavily ─────────────────────────────────────────

async function searchGooglePatents(drugName: string, sponsor?: string) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return [];
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
  const seen = new Set<string>();
  return allResults.filter((r) => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
}

// ─── Public LOE estimates via Tavily web search ───────────────────────────────

async function searchPublicLOEEstimates(drugName: string, sponsor?: string) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return [];
  const queries = [
    `"${drugName}" loss of exclusivity LOE date estimate${sponsor ? ` "${sponsor}"` : ""}`,
    `"${drugName}" patent expiry biosimilar generic launch year${sponsor ? ` "${sponsor}"` : ""}`,
  ];
  const allResults: any[] = [];
  for (const query of queries) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: tavilyKey, query, search_depth: "basic", max_results: 6 }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      allResults.push(...(data.results || []));
    } catch { continue; }
  }
  const seen = new Set<string>();
  return allResults.filter((r) => { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
}

// ─── Claude patent + web analysis ────────────────────────────────────────────

async function analyzePatentsWithClaude(
  drugName: string,
  sponsor: string | undefined,
  patentResults: any[],
  webResults: any[],
  orangeBookLoe: string | null
) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const patentList = patentResults.map((r, i) => {
    const numMatch = r.url?.match(/patent\/([A-Z]{2}[\w]+)/);
    const patentNum = numMatch ? numMatch[1] : "unknown";
    return `[${i + 1}] ${patentNum}\nTitle: ${r.title || "N/A"}\nURL: ${r.url || ""}\nSnippet: ${(r.content || "").slice(0, 500)}`;
  }).join("\n\n");

  const webList = webResults.map((r, i) =>
    `[W${i + 1}] ${r.title || "N/A"}\nURL: ${r.url || ""}\nSnippet: ${(r.content || "").slice(0, 400)}`
  ).join("\n\n");

  const obContext = orangeBookLoe
    ? `\n\nIMPORTANT: The FDA Orange Book has already confirmed LOE = ${orangeBookLoe}. Use the patents and market intelligence only for context.`
    : `\n\nNo Orange Book data found (likely a pipeline asset or biologic). Use patents and market intelligence to estimate the LOE range.`;

  const systemPrompt = `You are a pharmaceutical patent analyst.${obContext}

Patent types (most to least important for LOE):
1. Compound/composition — covers the active molecule
2. Formulation — specific delivery systems
3. Method-of-use — therapeutic indications
4. Process — manufacturing

Rules: US/EU patents = 20 years from filing. PTE = up to 5 extra years for FDA delay.

Extract any explicit LOE year estimates from market intelligence and note the source.

Respond ONLY with valid JSON:
{
  "loeMin": <integer year or null>,
  "loeMax": <integer year or null>,
  "bestEstimate": <integer year or null>,
  "confidence": "high" | "medium" | "low",
  "keyPatents": [
    { "number": "<e.g. US9073994B2>", "title": "<title>", "url": "<url>", "type": "compound" | "formulation" | "method-of-use" | "process" | "other", "filingYear": <integer or null>, "estimatedExpiry": <integer or null>, "relevance": "high" | "medium" | "low", "reason": "<one sentence>" }
  ],
  "marketIntelligence": [
    { "source": "<publisher>", "url": "<url>", "loeYearMentioned": <integer or null>, "snippet": "<key quote, max 120 chars>" }
  ],
  "patentContext": "<2-3 sentences>",
  "caveats": ["<caveat>"]
}`;

  const userContent = `Drug: ${drugName}${sponsor ? `\nSponsor: ${sponsor}` : ""}

PATENTS (${patentResults.length}):
${patentList || "None found."}

MARKET INTELLIGENCE (${webResults.length}):
${webList || "None found."}

Analyze all sources and provide your LOE assessment.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) throw new Error(`Claude error: ${res.status}`);
  const data = await res.json();
  const text = data?.content?.[0]?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Full LOE pipeline (shared by loe-full endpoint + auto-value) ─────────────

export type LoePipelineResult = {
  isDefinitive: boolean;
  loeYear: number | null;
  loeMin: number | null;
  loeMax: number | null;
  orangeBook: {
    found: boolean;
    loeDate: string | null;
    reasons: string[];
    sources: { label: string; url?: string }[];
  } | null;
  patents: {
    found: number;
    loeMin: number | null;
    loeMax: number | null;
    bestEstimate: number | null;
    confidence: string;
    keyPatents: any[];
    patentContext: string;
    caveats: string[];
    marketIntelligence: any[];
  } | null;
};

export async function runLoePipeline(
  drugName: string,
  sponsor?: string,
  hints?: { launchYear?: number; isBiologic?: boolean }
): Promise<LoePipelineResult> {
  const [obResult, patentResults, webResults] = await Promise.all([
    inferLOE(drugName).catch(() => null),
    searchGooglePatents(drugName, sponsor).catch(() => [] as any[]),
    searchPublicLOEEstimates(drugName, sponsor).catch(() => [] as any[]),
  ]);

  // Drug found in FDA = loeDate exists and reason doesn't say "not found in FDA database"
  const drugFoundInFDA = !!(
    obResult?.loeDate &&
    obResult.reasons?.[0] &&
    !obResult.reasons[0].includes("not found in FDA database")
  );
  // Confirmed = found + NOT a default estimate (i.e. real OB scrape or BPCIA with actual approval date)
  const obConfirmed = drugFoundInFDA && !obResult!.reasons.some((r) => r.includes("default estimate"));
  const obYear = obConfirmed ? Number(obResult!.loeDate!.slice(0, 4)) : null;

  let patentAnalysis: any = null;
  if (patentResults.length > 0 || webResults.length > 0) {
    try {
      patentAnalysis = await analyzePatentsWithClaude(
        drugName, sponsor, patentResults, webResults,
        obConfirmed ? obResult!.loeDate! : null
      );
    } catch { /* proceed without */ }
  }

  const fdaFallbackYear = drugFoundInFDA && obResult?.loeDate ? Number(obResult.loeDate.slice(0, 4)) : null;

  // If still no LOE and caller provided launch year hint, infer from exclusivity rules
  let hintLoeYear: number | null = null;
  if (hints?.launchYear && !obYear && !patentAnalysis?.bestEstimate && !fdaFallbackYear) {
    const exclusivityYears = hints.isBiologic ? 12 : 8;
    hintLoeYear = hints.launchYear + exclusivityYears;
  }

  const loeYear = obYear ?? patentAnalysis?.bestEstimate ?? fdaFallbackYear ?? hintLoeYear ?? null;
  const loeMin = obYear ?? patentAnalysis?.loeMin ?? fdaFallbackYear ?? hintLoeYear ?? null;
  const loeMax = obYear ?? patentAnalysis?.loeMax ?? fdaFallbackYear ?? hintLoeYear ?? null;

  return {
    isDefinitive: obConfirmed,
    loeYear,
    loeMin,
    loeMax,
    orangeBook: obResult ? {
      found: obConfirmed,
      loeDate: obResult.loeDate,
      reasons: obResult.reasons,
      sources: obResult.sources,
    } : null,
    patents: patentAnalysis ? {
      found: patentResults.length,
      loeMin: patentAnalysis.loeMin,
      loeMax: patentAnalysis.loeMax,
      bestEstimate: patentAnalysis.bestEstimate,
      confidence: patentAnalysis.confidence,
      keyPatents: patentAnalysis.keyPatents || [],
      patentContext: patentAnalysis.patentContext,
      caveats: patentAnalysis.caveats || [],
      marketIntelligence: patentAnalysis.marketIntelligence || [],
    } : null,
  };
}
