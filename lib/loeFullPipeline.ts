import { inferLOE } from "./loeAdapter";
import { callClaudeWithSearch } from "./claudeSearch";

// ─── Claude patent + LOE analysis with native web search ──────────────────────

async function analyzePatentsWithClaude(
  drugName: string,
  sponsor: string | undefined,
  orangeBookLoe: string | null,
  bpciaFloor: string | null = null
) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const obContext = orangeBookLoe
    ? `\n\nIMPORTANT: The FDA Orange Book has already confirmed LOE = ${orangeBookLoe}. Use patent and market intelligence searches only for context.`
    : bpciaFloor
    ? `\n\nNOTE: This is a biologic. BPCIA grants 12-year data exclusivity expiring ${bpciaFloor} — this is a regulatory FLOOR, not the patent LOE. Biosimilar entry is typically gated by compound patents, not just BPCIA. Search for compound/formulation patent expiry. Your bestEstimate should reflect the patent-based LOE, typically 2–4 years AFTER the BPCIA date.`
    : `\n\nNo Orange Book data found (likely a pipeline asset or biologic). Search for patents and market LOE estimates.`;

  const systemPrompt = `You are a pharmaceutical patent analyst.${obContext}

Use web_search to find:
1. Patents for ${drugName} on patents.google.com, lens.org, espacenet.com
2. Published LOE estimates from pharma industry sources
3. Biosimilar/generic launch timelines if applicable

Patent types (most to least important for LOE):
1. Compound/composition — covers the active molecule
2. Formulation — specific delivery systems
3. Method-of-use — therapeutic indications
4. Process — manufacturing

Rules: US/EU patents = 20 years from filing. PTE = up to 5 extra years for FDA delay.

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

Search for patents and LOE estimates, then analyze and provide your LOE assessment.`;

  const text = await callClaudeWithSearch({
    anthropicKey,
    system: systemPrompt,
    userMessage: userContent,
    maxTokens: 2500,
    maxSearches: 4,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Full LOE pipeline (shared by loe-full endpoint + auto-value) ─────────────

export type LoePipelineResult = {
  isDefinitive: boolean;
  isBpcia?: boolean;
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
  // FDA Orange Book lookup runs in parallel with Claude patent analysis
  const obResult = await inferLOE(drugName).catch(() => null);

  const drugFoundInFDA = !!(
    obResult?.loeDate &&
    obResult.reasons?.[0] &&
    !obResult.reasons[0].includes("not found in FDA database")
  );
  const obConfirmed = drugFoundInFDA && !obResult!.reasons.some((r) => r.includes("default estimate"));
  const isBpcia = !!(obResult as any)?.isBpcia;
  const obYear = obConfirmed ? Number(obResult!.loeDate!.slice(0, 4)) : null;

  const claudeObContext = obConfirmed ? obResult!.loeDate! : null;

  let patentAnalysis: any = null;
  try {
    patentAnalysis = await analyzePatentsWithClaude(
      drugName, sponsor,
      isBpcia ? null : claudeObContext,
      isBpcia ? obResult!.loeDate! : null
    );
  } catch { /* proceed without */ }

  const fdaFallbackYear = drugFoundInFDA && obResult?.loeDate ? Number(obResult.loeDate.slice(0, 4)) : null;

  let hintLoeYear: number | null = null;
  if (hints?.launchYear && !obYear && !patentAnalysis?.bestEstimate && !fdaFallbackYear) {
    const exclusivityYears = hints.isBiologic ? 12 : 8;
    hintLoeYear = hints.launchYear + exclusivityYears;
  }

  const patentBest = patentAnalysis?.bestEstimate ?? null;
  const patentMin  = patentAnalysis?.loeMin ?? null;
  const patentMax  = patentAnalysis?.loeMax ?? null;

  const loeYear = isBpcia
    ? (patentBest ?? obYear ?? fdaFallbackYear ?? hintLoeYear ?? null)
    : (obYear ?? patentBest ?? fdaFallbackYear ?? hintLoeYear ?? null);
  const loeMin = isBpcia
    ? (patentMin ?? obYear ?? fdaFallbackYear ?? hintLoeYear ?? null)
    : (obYear ?? patentMin ?? fdaFallbackYear ?? hintLoeYear ?? null);
  const loeMax = isBpcia
    ? (patentMax ?? obYear ?? fdaFallbackYear ?? hintLoeYear ?? null)
    : (obYear ?? patentMax ?? fdaFallbackYear ?? hintLoeYear ?? null);

  const isDefinitive = obConfirmed && !isBpcia;

  return {
    isDefinitive,
    isBpcia,
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
      found: 0, // Claude searched internally — no raw count available
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
