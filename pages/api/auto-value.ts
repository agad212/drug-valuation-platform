import type { NextApiRequest, NextApiResponse } from "next";
import { searchTrialsByDrug, type CtgovTrial } from "../../lib/ctgov";
import { runLoePipeline } from "../../lib/loeFullPipeline";

// ─── Claude: rank trials + extract peak sales in one call ────────────────────

async function analyzeWithClaude(
  drug: string,
  phase: string,
  trials: CtgovTrial[],
  revenueSearches: any[][],
  webContext?: string
): Promise<{
  selectedIndices: number[];
  recommendedIndex: number;
  reasons: Record<string, string>;
  summary: string;
  mechanism?: string;
  phase?: string;
  peakSalesEstimates: { peakSalesM: number; confidence: string; basis: string; devCostM?: number }[];
}> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const isApproved = phase === "Approved";
  const candidates = trials.slice(0, 40);

  const trialList = candidates.map((t, i) =>
    `[${i + 1}] ${t.nctId} | ${t.phaseRaw || t.phase || "?"} | ${t.statusLabel} | ${t.sponsor || "?"} | ${t.conditions?.[0] || "?"} | ${t.title?.slice(0, 80) || "?"}`
  ).join("\n");

  // Revenue context per indication (top 5 results each)
  const revenueContext = revenueSearches.map((results, i) => {
    const ind = candidates[i]?.conditions?.[0] || candidates[i]?.nctId || "Unknown";
    const snippets = results.slice(0, 4).map((r: any) =>
      `  - ${r.title || ""}: ${(r.content || "").slice(0, 250)}`
    ).join("\n");
    return `[${i + 1}] ${ind}:\n${snippets || "  No revenue data found"}`;
  }).join("\n\n");

  const systemPrompt = `You are a senior pharmaceutical BD analyst performing a drug asset valuation.
${isApproved ? "This drug is already approved. Identify pivotal approved indications and label expansions." : "This is a pipeline drug. Focus on Phase 3 registration trials."}

Your job:
1. Select 5-7 most relevant trials for valuation. If strategy/investor docs mention additional indications not in CT.gov, create synthetic entries for them (nctId = "PIPELINE-{n}").
2. Identify one recommended trial/indication to start with
3. Estimate peak annual sales per selected indication using web data and your training knowledge
4. For approved drugs: peak sales = total revenue in that indication at peak (use analyst breakdowns by tumor type if available)
5. For pipeline: estimate addressable market × realistic penetration
6. Extract precise mechanism of action from MOA web context — never use vague disclaimers

Peak sales guidelines:
- Major oncology indication (NSCLC, CRC, breast): $1B–$15B range typical for blockbusters
- Rare/niche indication: $200M–$2B
- If drug is already generating revenue: anchor on actual sales + growth trajectory
- Flag confidence: "high" (analyst data found), "medium" (extrapolated), "low" (estimated from market size)`;

  const userContent = `Drug: ${drug} | Stage: ${phase}

TRIALS (${candidates.length} experimental-arm matches):
${trialList}

REVENUE SEARCH RESULTS (per indication):
${revenueContext}${webContext ? `\n\nWEB CONTEXT — use this to:\n1. Extract mechanism: identify the specific MOA (e.g. "PD-1 inhibitor", "GABA-A modulator", "molecular photoswitch") — be precise, not generic\n2. Identify ALL indications from strategy docs/investor filings, not just what's in CT.gov\n3. Inform peak sales estimates\n\n${webContext}` : ""}

Respond ONLY with valid JSON:
{
  "selectedIndices": [1, 3, 5, ...],
  "recommendedIndex": 2,
  "reasons": { "NCT...": "one sentence why relevant for valuation" },
  "summary": "2-3 sentences on clinical landscape",
  "mechanism": "precise MOA from web context — e.g. 'molecular photoswitch / retinal photoactivation', 'PD-1 inhibitor', 'GABA-A modulator / benzodiazepine'. Never use vague disclaimers. Use web context above.",
  "phase": "MUST be exactly one of: Preclinical | Phase 1 | Phase 2 | Phase 3 | Filed | Approved",
  "peakSalesEstimates": [
    { "peakSalesM": 8000, "confidence": "high", "basis": "Goldman Sachs projects $8B peak NSCLC 1L", "devCostM": 500 },
    ...
  ]
}
REQUIRED: peakSalesEstimates must have exactly the same length and order as selectedIndices.
REQUIRED: devCostM must ALWAYS be a positive number — never null, never 0. It is the estimated total R&D cost in $M to reach approval for that indication:
- Phase 3 ongoing: $400–800M
- Phase 2 ongoing: $150–350M
- Phase 1 ongoing: $80–200M
- Preclinical: $50–100M
- Approved (label expansion): $100–300M`;

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
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) throw new Error(`Claude error: ${res.status}`);
  const data = await res.json();
  const text: string = data?.content?.[0]?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  const parsed = JSON.parse(jsonMatch[0]);

  // Normalize phase to valid dropdown values regardless of what Claude returned
  const VALID_PHASES = ["Preclinical", "Phase 1", "Phase 2", "Phase 3", "Filed", "Approved"];
  const raw = (parsed.phase || "").toLowerCase();
  if (raw.includes("approved")) parsed.phase = "Approved";
  else if (raw.includes("filed") || raw.includes("nda") || raw.includes("bla")) parsed.phase = "Filed";
  else if (raw.includes("phase 3") || raw.includes("phase3")) parsed.phase = "Phase 3";
  else if (raw.includes("phase 2") || raw.includes("phase2")) parsed.phase = "Phase 2";
  else if (raw.includes("phase 1") || raw.includes("phase1")) parsed.phase = "Phase 1";
  else if (!VALID_PHASES.includes(parsed.phase)) parsed.phase = "Phase 2";

  return parsed;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function cryptoId() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drug = String(req.query.drug || req.body?.drug || "").trim();
  const sponsor = String(req.query.sponsor || req.body?.sponsor || "").trim();
  const phase = String(req.query.phase || req.body?.phase || "Phase 2").trim();

  if (!drug) return res.status(400).json({ error: "drug parameter required" });

  const isApproved = phase === "Approved";

  try {
    // ── Round 1: CT.gov + LOE pipeline + drug intelligence searches in parallel ──
    const tavilyKey = process.env.TAVILY_API_KEY;
    async function tavilySearch(query: string, domains?: string[]): Promise<any[]> {
      if (!tavilyKey) return [];
      try {
        const body: any = { api_key: tavilyKey, query, search_depth: "basic", max_results: 5 };
        if (domains?.length) body.include_domains = domains;
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) return [];
        const d = await r.json();
        return d.results || [];
      } catch { return []; }
    }

    const [trials, loeResult, mechResults, strategyResults] = await Promise.all([
      searchTrialsByDrug(drug, { isApproved }).catch(() => [] as CtgovTrial[]),
      runLoePipeline(drug, sponsor || undefined).catch(() => null),
      // Mechanism of action: broad search first (no domain restriction) so news/press releases
      // about newly announced drugs surface, then scientific sources as fallback context
      tavilySearch(
        `"${drug}"${sponsor ? ` "${sponsor}"` : ""} mechanism indication treats disease target`
      ).catch(() => [] as any[]),
      // Pipeline strategy: plain search — no required phrases so Google-style results surface
      tavilySearch(
        `"${drug}"${sponsor ? ` "${sponsor}"` : ""} pipeline indication clinical development`
      ).catch(() => [] as any[]),
    ]);

    // If no CT.gov trials found, use a synthetic stub so Claude can still build
    // a model from training knowledge. Use the actual phase — don't assume Approved
    // (newly announced pipeline drugs also have no CT.gov entries yet).
    const syntheticStub: CtgovTrial[] = trials.length === 0 ? [{
      nctId: "N/A",
      title: isApproved
        ? `${drug} — approved product, no active trials`
        : `${drug} — pipeline asset, not yet in CT.gov (recently announced or pre-IND)`,
      phase: isApproved ? "Approved" : phase,
      statusLabel: isApproved ? "Approved" : "Pipeline",
      conditions: [drug],
      sponsor: sponsor || undefined,
      sources: [],
    } as any] : [];

    // Extract additional indications from strategy text via regex — no extra API call
    const strategyText = [...strategyResults, ...mechResults]
      .map((r: any) => `${r.title || ""} ${r.content || ""}`.slice(0, 800))
      .join(" ");

    // Scan for known disease/indication patterns in strategy text
    const INDICATION_PATTERNS = [
      /retinitis pigmentosa/gi, /choroideremia/gi, /stargardt(?:\s+disease)?/gi,
      /macular degeneration/gi, /leber(?:\s+congenital\s+amaurosis)?/gi,
      /usher syndrome/gi, /inherited retinal dystrophy/gi, /inherited retinal disease/gi,
      /cone[- ]rod dystrophy/gi, /achromatopsia/gi,
      // Oncology
      /non[- ]small[- ]cell lung/gi, /small[- ]cell lung/gi, /colorectal cancer/gi,
      /breast cancer/gi, /melanoma/gi, /hepatocellular/gi, /ovarian cancer/gi,
      /multiple myeloma/gi, /diffuse large b[- ]cell/gi, /follicular lymphoma/gi,
      /\baml\b|acute myeloid/gi, /\bcll\b|chronic lymphocytic/gi,
      // Neuro/CNS
      /alzheimer(?:'s)?(?: disease)?/gi, /parkinson(?:'s)?(?: disease)?/gi,
      /multiple sclerosis/gi, /amyotrophic lateral sclerosis|\bals\b/gi,
      // Immunology
      /rheumatoid arthritis/gi, /psoriasis/gi, /crohn(?:'s)?(?: disease)?/gi,
      /ulcerative colitis/gi, /atopic dermatitis/gi,
      // Rare disease
      /duchenne muscular dystrophy/gi, /spinal muscular atrophy/gi,
      /phenylketonuria/gi, /gaucher(?:'s)?(?: disease)?/gi,
      // Cardio/metabolic
      /heart failure/gi, /type 2 diabetes/gi, /obesity/gi, /nash|mash/gi,
    ];
    const foundIndications = new Set<string>();
    for (const pattern of INDICATION_PATTERNS) {
      const matches = strategyText.match(pattern);
      if (matches) {
        // Normalize to title case
        const normalized = matches[0].replace(/\b\w/g, c => c.toUpperCase()).trim();
        foundIndications.add(normalized);
      }
    }
    const pipelineIndications = [...foundIndications];

    // Build synthetic trial stubs for pipeline indications not already in CT.gov
    const ctgovConditionText = trials.flatMap((t: CtgovTrial) => (t.conditions || [])).join(" ").toLowerCase();
    const pipelineStubs: CtgovTrial[] = pipelineIndications
      .filter(ind => !ctgovConditionText.includes(ind.toLowerCase().split(" ")[0]))
      .slice(0, 4)
      .map((ind, i) => ({
        nctId: `PIPELINE-${i + 1}`,
        title: `${drug} — ${ind} (pipeline indication from investor/strategy docs)`,
        phase, statusLabel: "Pipeline",
        conditions: [ind],
        sponsor: sponsor || undefined,
        sources: [],
      } as any));

    const baseCandidates = trials.length > 0 ? trials.slice(0, 35) : syntheticStub;
    const candidates = [...baseCandidates, ...pipelineStubs];
    const usingSyntheticStub = trials.length === 0;

    const revenueSearches = candidates.map(() => [] as any[]);

    // Assemble web context: mechanism + strategy + LOE market intel
    const mechSnippets = mechResults.map((r: any) =>
      `[MOA] ${r.title || ""}: ${(r.content || "").slice(0, 300)}`
    ).join("\n");
    const strategySnippets = strategyResults.map((r: any) =>
      `[STRATEGY] ${r.title || ""}: ${(r.content || "").slice(0, 400)}`
    ).join("\n");
    const loeSnippets = loeResult?.patents?.marketIntelligence?.length
      ? loeResult.patents.marketIntelligence.map((m: any) => `[MARKET] ${m.source}: ${m.snippet}`).join("\n")
      : "";
    const webContext = [mechSnippets, strategySnippets, loeSnippets].filter(Boolean).join("\n") || undefined;

    // ── Round 2: Claude ranks trials + estimates peak sales ────────────────
    // Only treat as Approved if explicitly passed — don't assume Approved just because CT.gov returned nothing
    // (newly announced pipeline drugs also have no trials yet)
    const analysis = await analyzeWithClaude(drug, phase, candidates, revenueSearches, webContext);

    const indices = (analysis.selectedIndices || []).map((i: number) => i - 1);
    const recommendedRaw = (analysis.recommendedIndex ?? 1) - 1;

    // Normalize an indication name to a canonical key for deduplication
    const normalizeInd = (s: string) =>
      s.toLowerCase()
        .replace(/carcinoma,?\s+non[- ]small[- ]cell\s+lung/i, "nsclc")
        .replace(/non[- ]small[- ]?cell\s+lung\s+cancer/i, "nsclc")
        .replace(/non[- ]small[- ]?cell\s+lung\s+carcinoma/i, "nsclc")
        .replace(/\s+/g, " ").trim();

    const seenIndications = new Set<string>();
    let selectedTrials = indices
      .filter((i: number) => i >= 0 && i < candidates.length)
      .filter((i: number) => {
        const key = normalizeInd(candidates[i].conditions?.[0] || candidates[i].nctId);
        if (seenIndications.has(key)) return false;
        seenIndications.add(key);
        return true;
      })
      .map((i: number, rank: number) => ({
        trial: candidates[i],
        reason: analysis.reasons?.[candidates[i].nctId] || "",
        salesEstimate: analysis.peakSalesEstimates?.[rank] || null,
      }));

    // If Claude returned no selections (e.g. synthetic stub path), use all candidates
    if (selectedTrials.length === 0 && candidates.length > 0) {
      selectedTrials = candidates.slice(0, 5).map((trial, rank) => ({
        trial,
        reason: analysis.summary || "",
        salesEstimate: analysis.peakSalesEstimates?.[rank] || null,
      }));
    }

    const recommendedNctId = (recommendedRaw >= 0 && recommendedRaw < candidates.length)
      ? candidates[recommendedRaw].nctId
      : selectedTrials[0]?.trial.nctId || "";

    // ── Infer LOE from mechanism if pipeline returned nothing ────────────────
    let loeYear = loeResult?.loeYear ?? null;
    let biologicLoeNote: string | null = null;
    if (loeYear === null) {
      const mechLower = (analysis.mechanism || "").toLowerCase();
      const isBiologic =
        mechLower.includes("car-t") || mechLower.includes("car t") ||
        mechLower.includes("cell therapy") || mechLower.includes("antibody") ||
        mechLower.includes("mab") || mechLower.includes("adc") ||
        mechLower.includes("bispecific") || mechLower.includes("fusion protein") ||
        mechLower.includes("biologic");
      const refLaunchYear = selectedTrials[0]?.trial.estimatedLaunchYear;
      if (refLaunchYear) {
        const exclusivityYears = isBiologic ? 12 : 8;
        loeYear = refLaunchYear + exclusivityYears;
        biologicLoeNote = isBiologic
          ? `BPCIA 12-year biologic exclusivity estimated from launch year ${refLaunchYear}`
          : `Default ${exclusivityYears}-year exclusivity estimated from launch year ${refLaunchYear}`;
      }
    }

    const currentYear = new Date().getFullYear();
    const effectivelyApproved = (analysis.phase || "").toLowerCase().includes("approved");

    const indications = selectedTrials.map(({ trial, reason, salesEstimate }, rank) => ({
      id: cryptoId(),
      // For synthetic stub, extract indication from Claude's summary or basis text
      name: (usingSyntheticStub
        ? analysis.summary?.match(/(?:indicated for|approved for|treats?|used for)\s+([^.,;]+)/i)?.[1]?.trim()
          || analysis.peakSalesEstimates?.[rank]?.basis?.match(/(?:for|treating)\s+([^.,;(]+)/i)?.[1]?.trim()
          || drug
        : trial.conditions?.[0]) || trial.nctId,
      // For already-launched indications (estimatedLaunchYear undefined), use current year
      // so the DCF model can still compute revenue. Mark them as approved.
      launchYear: trial.estimatedLaunchYear ?? (effectivelyApproved ? currentYear : undefined),
      alreadyLaunched: !trial.estimatedLaunchYear && effectivelyApproved,
      loeYear: loeYear ?? undefined,
      nctId: trial.nctId,
      phase: trial.phase,
      sources: trial.sources,
      peakSales: salesEstimate?.peakSalesM ? Math.round(salesEstimate.peakSalesM * 1e6) : undefined,
      devCostPV: salesEstimate?.devCostM != null && salesEstimate.devCostM > 0 ? Math.round(salesEstimate.devCostM * 1e6) : undefined,
      peakSalesBasis: salesEstimate?.basis || undefined,
      peakSalesConfidence: salesEstimate?.confidence || undefined,
      claudeReason: reason,
    }));

    const sponsor_out = selectedTrials[0]?.trial.sponsor || sponsor || undefined;

    const allSources = [
      ...(loeResult?.orangeBook?.sources || []),
      ...selectedTrials.flatMap(({ trial }) => trial.sources),
    ];

    const trialCards = selectedTrials.map(({ trial, reason }) => ({ ...trial, claudeReason: reason }));

    // Attach biologic note to loeSource so LOE panel can display it
    const loeSourceOut = biologicLoeNote
      ? {
          ...(loeResult || {}),
          loeYear,
          loeMin: loeYear,
          loeMax: loeYear,
          orangeBook: {
            found: false,
            loeDate: `${loeYear}-12-31`,
            reasons: [biologicLoeNote],
            sources: [{ label: "BPCIA 12-year data exclusivity (42 U.S.C. § 262(k)(7))" }],
          },
        }
      : loeResult;

    return res.status(200).json({
      indications,
      trials: trialCards,
      loeYear,
      loeSource: loeSourceOut,
      mechanism: analysis.mechanism || undefined,
      phase: analysis.phase || undefined,
      sponsor: sponsor_out,
      summary: analysis.summary || "",
      recommendedNctId,
      sources: allSources,
      trialsScanned: trials.length,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Auto-value failed" });
  }
}
