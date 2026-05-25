// /api/ptrs-score
// Uses Claude + web search to score all mechanism factors for a drug,
// then runs the mechanism scorer to produce IPS, TRS, MSS, and PTRS adjustment.

import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../lib/claudeSearch";
import {
  scoreMechanism,
  UNKNOWN_FACTOR,
  type MechanismFactors,
  type FactorScore,
} from "../../lib/ptrs-mechanism-scorer";

// ─── Phase baseline PTRS (same as cashflow.ts) ────────────────────────────────

const PHASE_BASELINE: Record<string, number> = {
  Preclinical: 0.07,
  "Phase 1": 0.14,
  "Phase 2": 0.25,
  "Phase 3": 0.55,
  Filed: 0.85,
  Approved: 1.0,
};

// ─── Ask Claude to score all 5 factors via web search ─────────────────────────

async function scoreFeaturesWithClaude(
  drug: string,
  mechanism: string,
  indication: string,
  phase: string,
  sponsor: string | undefined,
  anthropicKey: string
): Promise<MechanismFactors> {
  const systemPrompt = `You are a senior pharmaceutical scientist scoring a drug's mechanism of action for a PTRS (probability of technical and regulatory success) model.

You must score exactly 5 factors. For each factor return a score (0–1), confidence level, one-sentence rationale, and whether it adds high variance/uncertainty.

FACTOR 1A — POTENCY (score 0–1):
How strongly does the drug bind/inhibit/activate its target at clinically achievable concentrations?
- 0.9–1.0: Coverage ratio >10x at trough, >90% target occupancy confirmed
- 0.7–0.9: Coverage ratio 3–10x, strong target engagement data
- 0.5–0.7: Coverage ratio 1–3x, partial engagement
- 0.3–0.5: Coverage ratio <1x or unknown, preclinical only
- Use 0.4 with highVariance=true if no PK/PD data available

FACTOR 1B — SELECTIVITY (score 0–1):
Does the drug hit its intended target preferentially over off-targets?
- 0.9–1.0: >1000x selective, no significant off-targets
- 0.8–0.9: 100–1000x selective, 1–2 minor off-targets
- 0.6–0.8: 10–100x selective, some known off-target effects
- 0.3–0.5: <10x selective or pan-active
- Special: intentionally multi-target with understood mechanism → 0.7, highVariance=false
- Biologics/mAbs are typically highly selective → score 0.85–0.95 unless known off-target issues

FACTOR 1C — PK PROFILE / HALF-LIFE (score 0–1):
Does the drug maintain adequate concentration at the target throughout the dosing interval?
- 0.9–1.0: Biologics/mAbs (long t½), covalent inhibitors, CAR-T/gene therapy
- 0.8–0.9: t½ >2x dosing interval, sustained coverage, low PK variability
- 0.6–0.8: t½ 1–2x dosing interval
- 0.4–0.6: t½ 0.5–1x dosing interval, some troughs
- 0.3–0.4: t½ <0.5x dosing interval, significant troughs
- Use 0.5 with highVariance=true if no PK data available yet (preclinical)

FACTOR 2A — TARGET VALIDATION (score 0–1):
How well validated is this target in this disease?
- 0.9–1.0: Genetically validated (human LoF/GoF genetics link target to disease) OR approved drug hitting same target in same indication
- 0.75–0.9: Clinically validated target in different indication (proven in humans, not this disease)
- 0.5–0.7: Strong preclinical validation (multiple animal models, human tissue data)
- 0.3–0.5: Hypothesis-driven (association data, single model)
- 0.1–0.3: Novel/uncharacterized target, first-in-class limited validation

FACTOR 2B — INDICATION-MECHANISM FIT (score 0–1):
How central is this target to the disease pathology being treated?
- 0.9–1.0: Target is the primary disease driver, no redundancy, biomarker-selected patients
- 0.7–0.9: Target is primary driver, some pathway redundancy, unselected patients
- 0.5–0.7: Target is secondary driver or downstream
- 0.2–0.4: Target is peripheral or compensatory
- Add +0.10 bonus (cap at 1.0) if patients are biomarker-selected for target relevance

Use web_search to research this drug before scoring. Search for:
- Published PK/PD data, IC50, selectivity profile
- Target validation evidence (genetics, approved drugs in class, animal models)
- Clinical data on target engagement and mechanism fit
- Any published PTRS or probability of success analyses

If data is unavailable for a factor, use score=0.4, confidence="unknown", highVariance=true.

IMPORTANT: Respond ONLY with valid JSON — no markdown, no explanation outside the JSON:
{
  "potency":          { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "selectivity":      { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "pkProfile":        { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "targetValidation": { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "indicationMechFit":{ "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false }
}`;

  const userMessage = `Drug: ${drug}
Mechanism of action: ${mechanism || "unknown"}
Indication: ${indication || "unknown"}
Development phase: ${phase}${sponsor ? `\nSponsor: ${sponsor}` : ""}

Search for published data on this drug's potency, selectivity, PK profile, target validation, and indication-mechanism fit. Then score all 5 factors.`;

  const raw = await callClaudeWithSearch({
    anthropicKey,
    system: systemPrompt,
    userMessage,
    maxTokens: 1500,
    maxSearches: 3,
    serperQueries: [
      `${drug} mechanism potency selectivity IC50`,
      `${drug} ${indication} target validation clinical data`,
    ],
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  const parsed = JSON.parse(jsonMatch[0]);

  // Validate and fill missing factors with UNKNOWN_FACTOR
  const factor = (key: string): FactorScore => {
    const f = parsed[key];
    if (!f || typeof f.score !== "number") return UNKNOWN_FACTOR;
    return {
      score: Math.max(0, Math.min(1, f.score)),
      confidence: ["high", "medium", "low", "unknown"].includes(f.confidence) ? f.confidence : "unknown",
      rationale: f.rationale || "No rationale provided.",
      highVariance: !!f.highVariance,
    };
  };

  return {
    potency: factor("potency"),
    selectivity: factor("selectivity"),
    pkProfile: factor("pkProfile"),
    targetValidation: factor("targetValidation"),
    indicationMechFit: factor("indicationMechFit"),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { drug, mechanism, indication, phase, sponsor } = req.body;
  if (!drug) return res.status(400).json({ error: "drug required" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  try {
    const factors = await scoreFeaturesWithClaude(
      drug, mechanism || "", indication || "", phase || "Phase 2",
      sponsor || undefined, anthropicKey
    );

    const result = scoreMechanism(factors);
    const baseline = PHASE_BASELINE[phase] ?? 0.25;
    const ptrs = Math.max(0.01, Math.min(1, baseline + result.ptrsAdjustment));

    return res.status(200).json({
      ptrs,
      baseline,
      ptrsAdjustment: result.ptrsAdjustment,
      ips: result.ips,
      trs: result.trs,
      mss: result.mss,
      variance: result.variance,
      factors: result.factors,
      summary: result.summary,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "PTRS scoring failed" });
  }
}
