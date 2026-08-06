import { inferLOE } from "./loeAdapter";
import { callClaudeWithSearch } from "./claudeSearch";

// ─── Claude patent + LOE analysis with native web search ──────────────────────

async function analyzePatentsWithClaude(
  drugName: string,
  sponsor: string | undefined,
  orangeBookLoe: string | null,
  bpciaFloor: string | null = null,
  // The indication being valued, so per-patent SCOPE can be judged against it (a method-of-use patent for a
  // different indication cannot protect this one). Absent → the analyst is told to emit scope as null rather
  // than guess, and the resolver's type probability carries the risk.
  indication?: string,
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
1. Compound/composition — covers the active molecule, for ALL indications
2. Formulation — only the specific delivery form
3. Method-of-use — ONLY its claimed therapeutic indication(s)
4. Process — manufacturing

YOU EMIT OBSERVABLES; THE ENGINE COMPUTES DATES. Report what the patent record SAYS. Do NOT add term
extensions, do NOT apply orphan/NCE exclusivity, and do NOT pick a final LOE year — deterministic code applies
Patent Term Extension (35 USC 156: +5yr cap, 14yr effective-life cap, and ONLY if the patent is still in force
at approval) and every statutory exclusivity clock.
- baseExpiry = earliest filing year + 20. Emit RAW, with NO PTE added.
- estimatedExpiry: ONLY if a granted term adjustment is actually documented; otherwise null.

SCOPE MATTERS MORE THAN LENGTH. For each patent state whether it covers THE INDICATION BEING VALUED
(coversValuedIndication). A method-of-use patent claiming a DIFFERENT indication is false — it cannot protect
this indication's revenue. Composition-of-matter is true. Formulation is true only if the commercial product
uses that form. Use null ONLY when the claims genuinely cannot be determined.

HOW LIKELY IS EACH PATENT TO ACTUALLY BLOCK GENERIC ENTRY (pProtective, 0-1)? Reason about design-around risk:
- Compound patents are hard to design around → high.
- Method-of-use patents are frequently circumvented: a generic omits the patented indication from its label
  (a "skinny label", FDCA section viii carve-out) and launches for the remaining uses. BUT the Federal
  Circuit's GSK v. Teva holding stands (Supreme Court denied cert, May 2023), so a generic whose own marketing
  encourages the carved-out use CAN be liable for induced infringement. So judge the specifics — above all:
  is there ANY other approved indication to skinny-label into? If not, the carve-out is useless to a generic
  and the patent is much stronger.
- ALWAYS pair pProtective with pProtectiveRationale. Without a rationale the engine discards the number and
  uses its own default, so an unexplained figure is wasted effort.

Respond ONLY with valid JSON:
{
  "loeMin": <integer year or null>,
  "loeMax": <integer year or null>,
  "bestEstimate": <integer year or null>,
  "confidence": "high" | "medium" | "low",
  "keyPatents": [
    { "number": "<e.g. US9073994B2>", "title": "<title>", "url": "<url>", "type": "compound" | "formulation" | "method-of-use" | "process" | "other", "filingYear": <integer or null>, "baseExpiry": <filing+20, RAW, no PTE, or null>, "estimatedExpiry": <documented granted adjustment only, else null>, "coversValuedIndication": <true | false | null>, "scopeRationale": "<what the claims actually cover>", "pProtective": <0-1 or null>, "pProtectiveRationale": "<design-around reasoning; REQUIRED for pProtective to be used>", "relevance": "high" | "medium" | "low", "reason": "<one sentence>" }
  ],
  "marketIntelligence": [
    { "source": "<publisher>", "url": "<url>", "loeYearMentioned": <integer or null>, "snippet": "<key quote, max 120 chars>" }
  ],
  "patentContext": "<2-3 sentences>",
  "caveats": ["<caveat>"]
}`;

  const userContent = `Drug: ${drugName}${sponsor ? `\nSponsor: ${sponsor}` : ""}${
    indication
      ? `\nINDICATION BEING VALUED: ${indication}\n\nJudge coversValuedIndication for every patent against THIS indication specifically.`
      : `\n(No specific indication supplied — set coversValuedIndication to null rather than guessing.)`
  }

Search for patents and LOE estimates, then report the patent record.`;

  const text = await callClaudeWithSearch({
    anthropicKey,
    system: systemPrompt,
    userMessage: userContent,
    maxTokens: 2500,
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

// ─── Full LOE pipeline (shared by loe-full endpoint + auto-value) ─────────────

export type LoePipelineResult = {
  isDefinitive: boolean;
  isBpcia?: boolean;
  loeYear: number | null;
  loeMin: number | null;
  loeMax: number | null;
  // How loeYear was derived: "patent" = calendar-fixed expiry date;
  // "exclusivity" = regulatory exclusivity anchored to approval/launch,
  // so it shifts if the launch year shifts.
  loeBasis: "patent" | "exclusivity" | null;
  exclusivityYears: number; // regulatory exclusivity term (12 biologic, 8 small molecule)
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
  hints?: { launchYear?: number; isBiologic?: boolean; indication?: string }
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
      isBpcia ? obResult!.loeDate! : null,
      hints?.indication
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

  // Same precedence as before, but track which candidate won: patent expiry
  // dates are calendar-fixed; BPCIA dates, FDA default estimates, and
  // launch+exclusivity hints are all anchored to approval/launch.
  const loeCandidates: [number | null, "patent" | "exclusivity"][] = isBpcia
    ? [[patentBest, "patent"], [obYear, "exclusivity"], [fdaFallbackYear, "exclusivity"], [hintLoeYear, "exclusivity"]]
    : [[obYear, "patent"], [patentBest, "patent"], [fdaFallbackYear, "exclusivity"], [hintLoeYear, "exclusivity"]];
  const loeWinner = loeCandidates.find(([y]) => y != null);
  const loeYear  = loeWinner?.[0] ?? null;
  const loeBasis = loeWinner?.[1] ?? null;
  const exclusivityYears = (isBpcia || hints?.isBiologic) ? 12 : 8;
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
    loeBasis,
    exclusivityYears,
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
