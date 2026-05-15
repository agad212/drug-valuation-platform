import type { NextApiRequest, NextApiResponse } from "next";
import { searchTrialsByDrug, type CtgovTrial } from "../../lib/ctgov";
import { runLoePipeline } from "../../lib/loeFullPipeline";
import { callClaudeWithSearch } from "../../lib/claudeSearch";

// ─── Claude: search web + rank trials + extract peak sales ───────────────────

async function analyzeWithClaude(
  drug: string,
  phase: string,
  trials: CtgovTrial[],
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

  const systemPrompt = `You are a senior pharmaceutical BD analyst performing a drug asset valuation.
${isApproved ? "This drug is already approved. Identify pivotal approved indications and label expansions." : "This is a pipeline drug. Focus on Phase 3 registration trials and pipeline indications."}

Use web_search to research this drug BEFORE answering. Search for:
1. Mechanism of action (be specific — drug target, pathway, modality)
2. All pipeline indications — check press releases, SEC filings, corporate presentations, company IR pages
3. Development phase and clinical status
4. Peak sales estimates or market size per indication

Your job:
1. Select 5-7 most relevant trials/indications for valuation. If web search reveals additional indications not in CT.gov, create synthetic entries (nctId = "PIPELINE-{n}").
2. Identify one recommended trial/indication to start with
3. Estimate peak annual sales per selected indication
4. For approved drugs: peak sales = total revenue in that indication at peak
5. For pipeline: estimate addressable market × realistic penetration
6. Extract precise mechanism of action — never say "unknown" or "insufficient context". Use your training knowledge if search returns nothing. If truly nothing is known, write "Unknown — pre-IND asset with no public disclosure".

Peak sales guidelines:
- Major oncology indication (NSCLC, CRC, breast): $1B–$15B range typical for blockbusters
- Rare/niche indication: $200M–$2B
- CNS/neurological (Alzheimer's, Parkinson's): $500M–$5B depending on mechanism novelty
- If drug is already generating revenue: anchor on actual sales + growth trajectory
- Flag confidence: "high" (analyst data found), "medium" (extrapolated), "low" (estimated from market size)

REQUIRED: devCostM must ALWAYS be a positive number. Estimated total R&D cost in $M to reach approval:
- Phase 3 ongoing: $400–800M
- Phase 2 ongoing: $150–350M
- Phase 1 ongoing: $80–200M
- Preclinical: $50–100M
- Approved (label expansion): $100–300M`;

  const userContent = `Drug: ${drug} | Stage: ${phase}

CT.gov trials found (${candidates.length}):
${trialList || "No trials found — search web to identify indications and development status"}

Search the web for mechanism, pipeline indications, and peak sales estimates. Then respond ONLY with valid JSON:
{
  "selectedIndices": [1, 3, 5, ...],
  "recommendedIndex": 2,
  "reasons": { "NCT...": "one sentence why relevant for valuation" },
  "summary": "2-3 sentences on clinical landscape",
  "mechanism": "precise MOA — e.g. 'PD-1 inhibitor', 'GABA-A modulator', 'anti-amyloid monoclonal antibody'. Never use vague disclaimers.",
  "phase": "MUST be exactly one of: Preclinical | Phase 1 | Phase 2 | Phase 3 | Filed | Approved",
  "peakSalesEstimates": [
    { "peakSalesM": 8000, "confidence": "high", "basis": "Goldman Sachs projects $8B peak NSCLC 1L", "devCostM": 500 }
  ]
}
REQUIRED: peakSalesEstimates must have exactly the same length and order as selectedIndices.`;

  const raw = await callClaudeWithSearch({
    anthropicKey,
    system: systemPrompt,
    userMessage: userContent,
    maxTokens: 2000,
    maxSearches: 5,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  const parsed = JSON.parse(jsonMatch[0]);

  // Normalize phase to valid dropdown values
  const VALID_PHASES = ["Preclinical", "Phase 1", "Phase 2", "Phase 3", "Filed", "Approved"];
  const rawPhase = (parsed.phase || "").toLowerCase();
  if (rawPhase.includes("approved")) parsed.phase = "Approved";
  else if (rawPhase.includes("filed") || rawPhase.includes("nda") || rawPhase.includes("bla")) parsed.phase = "Filed";
  else if (rawPhase.includes("phase 3") || rawPhase.includes("phase3")) parsed.phase = "Phase 3";
  else if (rawPhase.includes("phase 2") || rawPhase.includes("phase2")) parsed.phase = "Phase 2";
  else if (rawPhase.includes("phase 1") || rawPhase.includes("phase1")) parsed.phase = "Phase 1";
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
    // ── Round 1: CT.gov + LOE pipeline in parallel ────────────────────────────
    const [trials, loeResult] = await Promise.all([
      searchTrialsByDrug(drug, { isApproved }).catch(() => [] as CtgovTrial[]),
      runLoePipeline(drug, sponsor || undefined).catch(() => null),
    ]);

    // If no CT.gov trials found, use a synthetic stub so Claude can still build
    // a model from training knowledge + web search.
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

    const candidates = trials.length > 0 ? trials.slice(0, 40) : syntheticStub;
    const usingSyntheticStub = trials.length === 0;

    // ── Round 2: Claude searches web + ranks trials + estimates peak sales ────
    const analysis = await analyzeWithClaude(drug, phase, candidates);

    const indices = (analysis.selectedIndices || []).map((i: number) => i - 1);
    const recommendedRaw = (analysis.recommendedIndex ?? 1) - 1;

    // Normalize indication name for deduplication
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

    // ── Infer LOE from mechanism if pipeline returned nothing ─────────────────
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
      name: (usingSyntheticStub
        ? analysis.summary?.match(/(?:indicated for|approved for|treats?|used for)\s+([^.,;]+)/i)?.[1]?.trim()
          || analysis.peakSalesEstimates?.[rank]?.basis?.match(/(?:for|treating)\s+([^.,;(]+)/i)?.[1]?.trim()
          || drug
        : trial.conditions?.[0]) || trial.nctId,
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
