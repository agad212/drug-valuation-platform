import { inferLOE } from "./loeAdapter";
import { callClaudeWithSearch } from "./claudeSearch";
import { runElicitationChecker } from "./elicitation-checker";

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

ORPHAN DESIGNATION — you are already searching the registries and trade press that report it, so report it
as STRUCTURED data. FDA/EMA orphan designations are INDICATION-SPECIFIC: 7-year US orphan exclusivity runs
per approved use (21 USC 360cc(a)), so a designation granted for a DIFFERENT disease earns this valuation
nothing. Set confirmedForValuedIndication = true ONLY when you positively find a designation granted for the
indication being valued, and name the source. No source → it is not trusted and the engine default-denies.

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

ELICITATION PROTOCOL for pProtective — you are the expert under a facilitated probability elicitation.
Work EXTREMES FIRST, center last (anchoring runs downhill from the first number you commit to):
1. pProtectiveLow / pProtectiveHigh: your 15/85 bounds FIRST — a ~15% chance the true protective strength
   is below the low / above the high. Think how litigation, IPR, or a design-around could surprise you in
   each direction. Experts systematically under-cover the true range; when in doubt, widen.
2. pProtective: your central value, and it MUST lie inside the bounds.
3. crossCheckOutOf10: the SAME belief in a second framing — of 10 comparable patents of this type facing
   generic challenge (Paragraph IV litigation, IPR, design-around attempts), how many actually hold and
   protect the revenue? Answer from your knowledge of litigation outcomes for this patent type — do NOT
   just convert your pProtective. Disagreement between framings is expected signal (flagged, not punished).
A reviewer will audit your rationale for anchoring, availability (the one famous case), and base-rate
neglect (compound patents mostly hold; MOU patents mostly get carved out) — write reasoning that survives it.

Respond ONLY with valid JSON:
{
  "loeMin": <integer year or null>,
  "loeMax": <integer year or null>,
  "bestEstimate": <integer year or null>,
  "confidence": "high" | "medium" | "low",
  "keyPatents": [
    { "number": "<e.g. US9073994B2>", "title": "<title>", "url": "<url>", "type": "compound" | "formulation" | "method-of-use" | "process" | "other", "filingYear": <integer or null>, "baseExpiry": <filing+20, RAW, no PTE, or null>, "estimatedExpiry": <documented granted adjustment only, else null>, "coversValuedIndication": <true | false | null>, "scopeRationale": "<what the claims actually cover>", "pProtective": <0-1 or null>, "pProtectiveLow": <0-1, your 15th-percentile bound (state BEFORE the central), or null>, "pProtectiveHigh": <0-1, your 85th-percentile bound, or null>, "crossCheckOutOf10": <0-10: of 10 comparable challenged patents of this type, how many hold? or null>, "pProtectiveRationale": "<design-around reasoning; REQUIRED for pProtective to be used>", "relevance": "high" | "medium" | "low", "reason": "<one sentence>" }
  ],
  "marketIntelligence": [
    { "source": "<publisher>", "url": "<url>", "loeYearMentioned": <integer or null>, "snippet": "<key quote, max 120 chars>" }
  ],
  "orphanDesignation": {
    "confirmedForValuedIndication": <true | false | null>,
    "grantedDate": "<e.g. 2025-07 or null>",
    "source": "<the publisher/registry that states it — REQUIRED for this to be trusted, else null>",
    "rationale": "<one sentence: which indication the designation was granted for>"
  },
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
  // Indication-scoped orphan designation, default-denied unless explicitly confirmed WITH a named source.
  orphanDesignation: {
    confirmedForValuedIndication: boolean;
    grantedDate: string | null;
    source: string | null;
    rationale: string | null;
    unsourcedClaim: boolean;
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
    // Module 2: the facilitator checker's audit of the pProtective rationales (gated,
    // display-only prose with fail-open health markers — silence always means did-not-run).
    elicitationReview?: { findings: { severity: "high" | "medium" | "info"; message: string }[]; flags: string[] };
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

  // Module 2: the facilitator checker — one batched call auditing the pProtective RATIONALES
  // (never proposing numbers). Shared transport/gate/health markers (lib/elicitation-checker);
  // display-only prose attached to the patents block and rendered under Patent Analysis.
  let elicitationReview: { findings: { severity: "high" | "medium" | "info"; message: string }[]; flags: string[] } | undefined;
  const elicitedPats = (patentAnalysis?.keyPatents ?? []).filter((k: any) => k?.pProtective != null);
  if (elicitedPats.length) {
    const digest = elicitedPats.map((k: any) =>
      `${k.number} (${k.type}${k.coversValuedIndication === false ? ", does NOT cover the valued indication" : ""}): pProtective ${k.pProtective}${k.pProtectiveLow != null ? ` (15/85 range ${k.pProtectiveLow}–${k.pProtectiveHigh ?? "?"})` : ""}${k.crossCheckOutOf10 != null ? `, cross-check "${k.crossCheckOutOf10} of 10 hold"` : ""} — rationale: ${k.pProtectiveRationale ?? "(none — the engine will discard this number)"}`
    ).join("\n");
    elicitationReview = await runElicitationChecker({
      apiKey: process.env.ANTHROPIC_API_KEY,
      subjectLabel: "the patent-strength elicitations",
      allowedQuantities: ["pProtective", "loeRange", "general"],
      prompt: `You are the FACILITATOR auditing a patent analyst's protective-probability elicitations for ${drugName}${hints?.indication ? ` (valued indication: ${hints.indication})` : ""}. Audit each RATIONALE — never propose a replacement number; any number you mention must be copied from the input.

${digest}

Overall LOE range stated: ${patentAnalysis?.loeMin ?? "?"}–${patentAnalysis?.loeMax ?? "?"} (best ${patentAnalysis?.bestEstimate ?? "?"}).

Report ONLY genuine issues (max 5):
1. Base-rate neglect: compound patents mostly survive challenge; method-of-use patents mostly get carved out (§viii) — a value fighting those base rates needs case-specific evidence.
2. Anchoring: pProtective suspiciously equal to a round default or another patent's value.
3. Availability: rationale leaning on one famous case (e.g. GSK v. Teva alone) rather than the litigation record for this patent type.
4. Rationale↔number arithmetic: a cross-check tally of "N of 10 hold" must roughly imply the stated probability; a hedge-filled rationale must not carry a confident number.
5. Scope coherence: a patent said NOT to cover the valued indication cannot justify a late LOE; ranges too narrow given admitted uncertainty.

Respond with STRICT JSON only:
{"findings":[{"quantity":"pProtective|loeRange|general","severity":"high|medium|info","message":"one or two sentences, name the patent number"}]}
Empty findings array if everything is defensible.`,
    });
  }

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
      ...(elicitationReview ? { elicitationReview } : {}),
    } : null,
    // Structured, indication-scoped orphan designation from the retriever that actually reads the orphan
    // registries/trade press. A SECOND independent confirmation path alongside /api/ptrs-layer2: the two
    // endpoints search separately, and on the flagship the LOE pipeline found "FDA granted Orphan Drug
    // Designation … for IPF" while layer2 returned "standard", so the 7-year term was lost. Default-deny:
    // trusted only when confirmedForValuedIndication is explicitly true AND a source is named.
    orphanDesignation: (() => {
      const o = patentAnalysis?.orphanDesignation;
      if (!o || typeof o !== "object") return null;
      const source = typeof o.source === "string" && o.source.trim() ? o.source.trim() : null;
      const confirmed = o.confirmedForValuedIndication === true && !!source;
      return {
        confirmedForValuedIndication: confirmed,
        grantedDate: typeof o.grantedDate === "string" ? o.grantedDate : null,
        source,
        rationale: typeof o.rationale === "string" ? o.rationale : null,
        // Surfaces the "claimed but uncited" case rather than silently dropping it.
        unsourcedClaim: o.confirmedForValuedIndication === true && !source,
      };
    })(),
  };
}
