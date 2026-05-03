import type { NextApiRequest, NextApiResponse } from "next";

// ─── Tavily search helpers ────────────────────────────────────────────────────

async function tavilySearch(query: string, domains?: string[]): Promise<any[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const body: any = { api_key: key, query, search_depth: "basic", max_results: 4 };
    if (domains?.length) body.include_domains = domains;
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch { return []; }
}

// ─── Claude revenue analysis ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior sell-side pharmaceutical analyst at a top-tier investment bank. You specialize in drug asset revenue modeling with 15+ years of experience covering biopharmaceuticals. You write equity research initiation reports.

## PRICING BENCHMARKS (WAC per patient per year, US market)
- PD-1/PD-L1 checkpoint inhibitors (oncology): $150,000–$200,000/yr
- ADC (antibody-drug conjugates): $200,000–$350,000/yr
- CAR-T / cell therapies: $400,000–$600,000 one-time
- Rare disease / orphan (<200K patients US): $300,000–$600,000/yr
- Common solid tumor oncology: $100,000–$180,000/yr
- Hematology (AML, MDS, multiple myeloma): $150,000–$300,000/yr
- Immunology / autoimmune (RA, IBD, psoriasis): $30,000–$80,000/yr
- Neurology / CNS: $20,000–$80,000/yr (rare CNS: $200,000–$500,000/yr)
- Cardiovascular: $5,000–$25,000/yr
- Metabolic / diabetes: $5,000–$15,000/yr (GLP-1: $12,000–$20,000/yr)

## PEAK PENETRATION BENCHMARKS (5–8 years post-launch)
- First-in-class in major unmet need, no competition: 30–55%
- Best-in-class with clinical differentiation: 20–35%
- Me-too entrant in crowded market: 8–18%
- Label expansion (additional indication for approved drug): 10–20% incremental
- Combination / adjuvant use: 15–30%

## COMPARABLE DRUG METHODOLOGY
Anchor estimates on real-world named comparables. Priority:
1. Same mechanism in same indication (ideal comp)
2. Same indication, different mechanism
3. Same mechanism, different indication (scale for prevalence)
Always adjust for label breadth, launch timing, pricing era, and competitive dynamics.

## BULL / BASE / BEAR LOGIC
- Bull: +40–80% above base (best-case label, fast uptake, pricing strength, combo use, ex-US outperformance)
- Bear: -40–60% below base (pricing pressure, competitive crowding, safety signal, narrow label, slow uptake)
- Confidence = "high" if ≥2 named analyst estimates found; "medium" if 1 estimate or clear market-size data; "low" if pure model

## RULES
- Express ALL monetary values in USD millions (M)
- If analyst search results contain explicit estimates, extract and cite them verbatim; never fabricate source names or numbers
- reasoning must be exactly 3–4 sentences covering: (1) patient population size & eligible subset, (2) pricing assumption & comparable drug anchor, (3) penetration rationale, (4) key risk or upside driver
- Return ONLY valid JSON — no markdown fences, no extra text`;

async function analyzeRevenueWithClaude(
  drug: string,
  phase: string,
  sponsor: string | undefined,
  indicationsWithResults: { indication: string; analyst: any[]; epidemiology: any[]; comps: any[] }[]
): Promise<any> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const snippetLen = Math.max(200, Math.floor(5000 / Math.max(1, indicationsWithResults.length)));

  const context = indicationsWithResults.map(({ indication, analyst, epidemiology, comps }) => {
    const fmt = (results: any[], label: string) => {
      if (!results.length) return `  ${label}: No results found.`;
      return `  ${label}:\n` + results.map((r, i) =>
        `  [${i + 1}] ${r.title || "?"}\n      ${(r.content || "").slice(0, snippetLen)}\n      URL: ${r.url || "?"}`
      ).join("\n");
    };
    return `=== INDICATION: ${indication} ===\n${fmt(analyst, "ANALYST ESTIMATES / CONSENSUS")}\n\n${fmt(epidemiology, "MARKET SIZE / EPIDEMIOLOGY")}\n\n${fmt(comps, "COMPETITIVE LANDSCAPE / COMPS")}`;
  }).join("\n\n");

  const schema = `{
  "indications": [
    {
      "indication": string,
      "peakSalesM": number,
      "bullM": number,
      "bearM": number,
      "confidence": "high" | "medium" | "low",
      "reasoning": string,
      "analystEstimates": [{ "source": string, "url": string|null, "estimateM": number, "year": number|null, "quote": string }],
      "marketContext": { "tamM": number|null, "penetrationPct": number|null, "patientPopDesc": string|null, "pricingPerYear": number|null /* full USD e.g. 150000 for $150K/yr, 450000 for $450K/yr */, "competitive": string|null },
      "comps": [{ "drug": string, "indication": string, "peakSalesM": number, "rationale": string }],
      "sources": [{ "label": string, "url": string|null }]
    }
  ]
}`;

  const userContent = `Drug: ${drug}
Development Phase: ${phase}${sponsor ? `\nSponsor: ${sponsor}` : ""}
Number of indications: ${indicationsWithResults.length}
Required indication order: ${indicationsWithResults.map(i => i.indication).join(" | ")}

SEARCH RESULTS BY INDICATION:
${context}

Return JSON exactly matching this schema. The indications array MUST have exactly ${indicationsWithResults.length} entries in the same order as listed above:
${schema}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) throw new Error(`Claude error: ${res.status}`);
  const data = await res.json();
  const text: string = data?.content?.[0]?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { drug, phase, indications, sponsor } = req.body;
  if (!drug || !Array.isArray(indications) || indications.length === 0) {
    return res.status(400).json({ error: "drug and indications[] required" });
  }

  try {
    // Fan out all Tavily searches in parallel — batch into groups of 6 to avoid rate limiting
    const searchFns = indications.flatMap((ind: string) => [
      () => tavilySearch(`"${drug}" "${ind}" peak sales analyst estimate forecast consensus billion`),
      () => tavilySearch(`"${ind}" patient population prevalence incidence treatment market size`),
      () => tavilySearch(`"${drug}" comparable drug peak revenue market share competition "${ind}"`),
    ]);

    const BATCH = 6;
    const allResults: any[][] = [];
    for (let i = 0; i < searchFns.length; i += BATCH) {
      const batch = searchFns.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(fn => fn()));
      allResults.push(...batchResults);
    }

    const indicationsWithResults = indications.map((ind: string, i: number) => ({
      indication: ind,
      analyst:      allResults[i * 3 + 0] || [],
      epidemiology: allResults[i * 3 + 1] || [],
      comps:        allResults[i * 3 + 2] || [],
    }));

    const analysis = await analyzeRevenueWithClaude(drug, phase, sponsor, indicationsWithResults);

    // Realign by index, fill gaps if Claude returns wrong count
    const rawInds: any[] = analysis.indications || [];
    const aligned = indications.map((ind: string, i: number) => {
      const found = rawInds[i] || rawInds.find((r: any) =>
        r.indication?.toLowerCase().includes(ind.toLowerCase().split(" ")[0].toLowerCase())
      );
      return found || {
        indication: ind, peakSalesM: 0, bullM: 0, bearM: 0,
        confidence: "low", reasoning: "Analysis unavailable for this indication.",
        analystEstimates: [], marketContext: {}, comps: [], sources: [],
      };
    });

    // Attach raw sources for each indication
    const withSources = aligned.map((ind: any, i: number) => {
      const allRaw = [...(indicationsWithResults[i]?.analyst || []), ...(indicationsWithResults[i]?.epidemiology || []), ...(indicationsWithResults[i]?.comps || [])];
      const extraSources = allRaw
        .filter((r: any) => r.url)
        .slice(0, 4)
        .map((r: any) => ({ label: r.title || r.url, url: r.url }));
      return {
        ...ind,
        sources: [...(ind.sources || []), ...extraSources].slice(0, 8),
      };
    });

    return res.status(200).json({ drug, phase, indications: withSources });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Revenue analysis failed" });
  }
}
