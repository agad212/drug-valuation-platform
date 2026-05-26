// /api/ptrs-layer2
// Layer 2: Trial Design Simulation.
// Claude searches for the drug's trial design parameters (sample size, endpoint type,
// design type, patient selection, regulatory designations) then runs the closed-form
// Layer 2 scorer to adjust the Layer 1 PTRS.

import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../lib/claudeSearch";
import {
  scoreLayer2,
  type TrialDesignInputs,
  type EndpointType,
  type DesignType,
  type PopulationType,
  type PlaceboResponse,
  type RegulatoryContext,
} from "../../lib/ptrs-trial";

// ─── Phase benchmark ranges (mirrored from ptrs-score.ts) ────────────────────

const PHASE_BENCHMARKS: Record<string, { p10: number; p25: number; median: number; p75: number; p90: number; label: string }> = {
  Preclinical: { p10: 0.02, p25: 0.04, median: 0.07, p75: 0.10, p90: 0.15, label: "Preclinical" },
  "Phase 1":   { p10: 0.06, p25: 0.09, median: 0.14, p75: 0.20, p90: 0.28, label: "Phase 1" },
  "Phase 2":   { p10: 0.09, p25: 0.15, median: 0.25, p75: 0.38, p90: 0.50, label: "Phase 2" },
  "Phase 3":   { p10: 0.25, p25: 0.38, median: 0.55, p75: 0.68, p90: 0.78, label: "Phase 3" },
  Filed:       { p10: 0.72, p25: 0.80, median: 0.85, p75: 0.92, p90: 0.96, label: "Filed" },
  Approved:    { p10: 1.00, p25: 1.00, median: 1.00, p75: 1.00, p90: 1.00, label: "Approved" },
};

function computePercentile(ptrs: number, phase: string) {
  const bm = PHASE_BENCHMARKS[phase] ?? PHASE_BENCHMARKS["Phase 2"];
  let pct: number;
  if (ptrs >= bm.p90) pct = 90 + Math.min(10, (ptrs - bm.p90) / (1 - bm.p90) * 10);
  else if (ptrs >= bm.p75) pct = 75 + (ptrs - bm.p75) / (bm.p90 - bm.p75) * 15;
  else if (ptrs >= bm.median) pct = 50 + (ptrs - bm.median) / (bm.p75 - bm.median) * 25;
  else if (ptrs >= bm.p25) pct = 25 + (ptrs - bm.p25) / (bm.median - bm.p25) * 25;
  else if (ptrs >= bm.p10) pct = 10 + (ptrs - bm.p10) / (bm.p25 - bm.p10) * 15;
  else pct = Math.max(1, ptrs / bm.p10 * 10);
  pct = Math.round(Math.min(99, Math.max(1, pct)));
  const label = pct >= 75 ? "Top quartile" : pct >= 50 ? "Above median" : pct >= 25 ? "Below median" : "Bottom quartile";
  return { percentile: pct, label, benchmarks: bm };
}

// ─── Claude extracts trial design inputs ─────────────────────────────────────

async function extractTrialDesign(
  drug: string,
  indication: string,
  phase: string,
  sponsor: string | undefined,
  nctId: string | undefined,
  anthropicKey: string
): Promise<TrialDesignInputs> {

  const systemPrompt = `You are a clinical trial design expert extracting trial parameters for a PTRS (probability of technical and regulatory success) model.

Search for the drug's key clinical trial and extract EXACTLY these parameters. Return ONLY valid JSON, no markdown.

PARAMETER 1 — SAMPLE SIZE (n):
Search for enrollment numbers in the key Phase 2 or Phase 3 trial.
- Return the actual enrolled n, not target enrollment if different
- If range (e.g. "up to 100"): use the lower realistic estimate
- If unknown: use 60 as default (typical Phase 2)
- For rare diseases: n=20-50 is normal

PARAMETER 2 — ENDPOINT TYPE (endpointType):
Classify the PRIMARY endpoint:
- "hard": OS (overall survival), EFS, PFS-V (verified PFS), CR (complete response by imaging), histopathologic confirmation, organ function (eGFR, FEV1)
- "surrogate": ORR, PFS, DFS, PSA response, PK/PD biomarker, biochemical endpoint, visual acuity (BCVA), functional vision tests, ECG parameters
- "pro": Patient-reported pain, QoL (PROMIS, SF-36), ADAS-cog, UPDRS, MMSE (unless imaging confirmed), function scores without objective confirmation

PARAMETER 3 — DESIGN TYPE (designType):
- "rct": Randomized controlled with concurrent comparator (placebo arm or active control)
- "single_arm": Open-label with historical control, no randomization, or single cohort
- "basket": Multi-tumor basket, umbrella trial, platform trial, or master protocol

PARAMETER 4 — PATIENT POPULATION (populationType):
- "biomarker_selected": Patients selected based on a specific biomarker (KRAS, HER2, MSI-H, specific gene mutation, specific protein expression)
- "broad": Unselected by biomarker, all-comers in indication
- "rare_small": Total eligible patient population <10,000 globally OR trial enrolls <40 patients

PARAMETER 5 — PLACEBO RESPONSE (placeboResponse):
Classify by INDICATION, not by trial design:
- "low": Oncology (all cancers), rare diseases with objective endpoints, serious diseases with hard endpoints
- "moderate": Autoimmune/inflammatory (RA, IBD, psoriasis), metabolic, cardiovascular, non-rare neurology with objective endpoints
- "high": CNS/psychiatric (depression, anxiety, schizophrenia, bipolar, insomnia), pain (neuropathic, chronic back, fibromyalgia), IBS/functional GI, subjective symptom scales

PARAMETER 6 — REGULATORY CONTEXT (regulatoryContext):
Search specifically for these FDA designations for this drug in this indication:
- "btd_orphan": Has BOTH Breakthrough Therapy Designation AND Orphan Drug Designation
- "btd": Has Breakthrough Therapy Designation only
- "orphan": Has Orphan Drug Designation only
- "accelerated": Accelerated Approval pathway without BTD
- "confirmatory": Post-accelerated approval confirmatory trial
- "standard": No special designation

ALSO RETURN:
- endpointDescription: the exact name of the primary endpoint (e.g. "Best Corrected Visual Acuity (BCVA) at 12 months")
- enrollmentNote: a brief note on enrollment (e.g. "36 patients, LCA5-confirmed, single-arm open label")

Use web_search to find this trial. Search for: "${drug} clinical trial enrollment primary endpoint phase design"
Also search: "${drug} breakthrough therapy orphan drug designation FDA"${nctId ? `\nAlso look up NCT ID: ${nctId}` : ""}

RESPOND WITH ONLY THIS JSON:
{
  "n": 0,
  "endpointType": "hard|surrogate|pro",
  "designType": "rct|single_arm|basket",
  "populationType": "biomarker_selected|broad|rare_small",
  "placeboResponse": "low|moderate|high",
  "regulatoryContext": "standard|btd|orphan|btd_orphan|accelerated|confirmatory",
  "endpointDescription": "description of primary endpoint",
  "enrollmentNote": "brief enrollment note"
}`;

  const userMessage = `Drug: ${drug}
Indication: ${indication || "unknown"}
Phase: ${phase}${sponsor ? `\nSponsor: ${sponsor}` : ""}${nctId ? `\nNCT ID: ${nctId}` : ""}

Search for this drug's key clinical trial and extract all 6 trial design parameters.`;

  const raw = await callClaudeWithSearch({
    anthropicKey,
    model: "claude-haiku-4-5-20251001",
    system: systemPrompt,
    userMessage,
    maxTokens: 800,
    maxSearches: 0,   // Haiku does not support web_search; relies on Serper context below
    serperQueries: [
      `${drug} clinical trial enrollment design endpoint ${indication}`,
      `${drug} FDA breakthrough therapy orphan designation`,
    ],
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response for trial design");
  const parsed = JSON.parse(jsonMatch[0]);

  const VALID_ENDPOINT: EndpointType[] = ["hard", "surrogate", "pro"];
  const VALID_DESIGN: DesignType[] = ["rct", "single_arm", "basket"];
  const VALID_POP: PopulationType[] = ["biomarker_selected", "broad", "rare_small"];
  const VALID_PLACEBO: PlaceboResponse[] = ["low", "moderate", "high"];
  const VALID_REG: RegulatoryContext[] = ["standard", "btd", "orphan", "btd_orphan", "accelerated", "confirmatory"];

  return {
    n: (typeof parsed.n === "number" && parsed.n > 0) ? Math.round(parsed.n) : 60,
    endpointType: VALID_ENDPOINT.includes(parsed.endpointType) ? parsed.endpointType : "surrogate",
    designType: VALID_DESIGN.includes(parsed.designType) ? parsed.designType : "rct",
    populationType: VALID_POP.includes(parsed.populationType) ? parsed.populationType : "broad",
    placeboResponse: VALID_PLACEBO.includes(parsed.placeboResponse) ? parsed.placeboResponse : "low",
    regulatoryContext: VALID_REG.includes(parsed.regulatoryContext) ? parsed.regulatoryContext : "standard",
    endpointDescription: parsed.endpointDescription || "",
    enrollmentNote: parsed.enrollmentNote || "",
    nctId,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { drug, indication, phase, sponsor, nctId, layer1 } = req.body;
  if (!drug || !layer1) return res.status(400).json({ error: "drug and layer1 result required" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { mss, variance, ptrs: ptrsLayer1, ciHalfWidth } = layer1;
  if (typeof mss !== "number" || typeof variance !== "number" || typeof ptrsLayer1 !== "number") {
    return res.status(400).json({ error: "layer1 must include mss, variance, ptrs, ciHalfWidth" });
  }

  try {
    let trialInputs: TrialDesignInputs | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        trialInputs = await extractTrialDesign(
          drug, indication || "", phase || "Phase 2",
          sponsor || undefined, nctId || undefined, anthropicKey
        );
        break;
      } catch (e: any) {
        const is429 = e?.message?.includes("429");
        if (attempt === 3) throw e;
        const wait = is429 ? (attempt + 1) * 30000 : 5000;
        console.warn(`[layer2] attempt ${attempt + 1} failed (${e?.message}), waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }

    if (!trialInputs) throw new Error("Trial design extraction failed after retries");

    const result = scoreLayer2(mss, variance, ptrsLayer1, ciHalfWidth ?? 0.10, trialInputs);
    const phaseBenchmark = computePercentile(result.ptrsCombined, phase || "Phase 2");

    return res.status(200).json({
      // Layer 1 pass-through
      ptrsLayer1,
      // Layer 2 results
      ptrsCombined: result.ptrsCombined,
      ptrsCI: result.ptrsCI,
      layer2Multiplier: result.layer2Multiplier,
      layer2Delta: result.layer2Delta,
      trialSuccessProb: result.trialSuccessProb,
      sigma2Trial: result.sigma2Trial,
      riskFlags: result.riskFlags,
      trialInputs: result.inputs,
      summary: result.summary,
      phaseBenchmark,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Layer 2 scoring failed" });
  }
}
