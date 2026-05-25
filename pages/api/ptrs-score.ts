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

// ─── Phase benchmark ranges — based on DiMasi (2016) / Hay et al (2014) ──────
// p10, p25, median (p50), p75, p90 — probability of ultimately reaching approval

const PHASE_BENCHMARKS: Record<string, { p10: number; p25: number; median: number; p75: number; p90: number; label: string }> = {
  Preclinical: { p10: 0.02, p25: 0.04, median: 0.07, p75: 0.10, p90: 0.15, label: "Preclinical" },
  "Phase 1":   { p10: 0.06, p25: 0.09, median: 0.14, p75: 0.20, p90: 0.28, label: "Phase 1" },
  "Phase 2":   { p10: 0.09, p25: 0.15, median: 0.25, p75: 0.38, p90: 0.50, label: "Phase 2" },
  "Phase 3":   { p10: 0.25, p25: 0.38, median: 0.55, p75: 0.68, p90: 0.78, label: "Phase 3" },
  Filed:       { p10: 0.72, p25: 0.80, median: 0.85, p75: 0.92, p90: 0.96, label: "Filed" },
  Approved:    { p10: 1.00, p25: 1.00, median: 1.00, p75: 1.00, p90: 1.00, label: "Approved" },
};

function computePercentile(ptrs: number, phase: string): { percentile: number; label: string; benchmarks: typeof PHASE_BENCHMARKS[string] } {
  const bm = PHASE_BENCHMARKS[phase] ?? PHASE_BENCHMARKS["Phase 2"];
  let percentile: number;
  if (ptrs >= bm.p90) percentile = 90 + Math.min(10, (ptrs - bm.p90) / (1 - bm.p90) * 10);
  else if (ptrs >= bm.p75) percentile = 75 + (ptrs - bm.p75) / (bm.p90 - bm.p75) * 15;
  else if (ptrs >= bm.median) percentile = 50 + (ptrs - bm.median) / (bm.p75 - bm.median) * 25;
  else if (ptrs >= bm.p25) percentile = 25 + (ptrs - bm.p25) / (bm.median - bm.p25) * 25;
  else if (ptrs >= bm.p10) percentile = 10 + (ptrs - bm.p10) / (bm.p25 - bm.p10) * 15;
  else percentile = Math.max(1, ptrs / bm.p10 * 10);
  percentile = Math.round(Math.min(99, Math.max(1, percentile)));
  const label =
    percentile >= 75 ? "Top quartile" :
    percentile >= 50 ? "Above median" :
    percentile >= 25 ? "Below median" : "Bottom quartile";
  return { percentile, label, benchmarks: bm };
}

// ─── Ask Claude to score all 9 factors via web search ─────────────────────────

async function scoreFeaturesWithClaude(
  drug: string,
  mechanism: string,
  indication: string,
  phase: string,
  sponsor: string | undefined,
  anthropicKey: string
): Promise<MechanismFactors> {
  const systemPrompt = `You are a senior pharmaceutical scientist scoring a drug's mechanism of action for a PTRS (probability of technical and regulatory success) model.

You must score exactly 9 factors across two sub-components. For each factor return a score (0–1), confidence level, one-sentence rationale, and whether it adds high variance/uncertainty.

═══════════════════════════════════════════════════════════
SUB-COMPONENT 1: INTRINSIC POTENCY SCORE (IPS)
═══════════════════════════════════════════════════════════

FACTOR 1A — POTENCY (weight 25%):
How strongly does the drug bind/inhibit/activate its target at clinically achievable concentrations?
- 0.9–1.0: Coverage ratio >10x at trough, >90% target occupancy confirmed
- 0.7–0.9: Coverage ratio 3–10x, strong target engagement data
- 0.5–0.7: Coverage ratio 1–3x, partial engagement
- 0.3–0.5: Coverage ratio <1x or unknown, preclinical only
- Use 0.4 with highVariance=true if no PK/PD data available

FACTOR 1B — SELECTIVITY (weight 20%):
Does the drug hit its intended target preferentially over off-targets?
- 0.9–1.0: >1000x selective, no significant off-targets
- 0.8–0.9: 100–1000x selective, 1–2 minor off-targets
- 0.6–0.8: 10–100x selective, some known off-target effects
- 0.3–0.5: <10x selective or pan-active
- Special: intentionally multi-target with understood mechanism → 0.7, highVariance=false
- Biologics/mAbs are typically highly selective → score 0.85–0.95 unless known off-target issues

FACTOR 1C — PK PROFILE / HALF-LIFE (weight 20%):
Does the drug maintain adequate concentration at the target throughout the dosing interval?
- 0.9–1.0: Biologics/mAbs (long t½), covalent inhibitors, CAR-T/gene therapy
- 0.8–0.9: t½ >2x dosing interval, sustained coverage, low PK variability
- 0.6–0.8: t½ 1–2x dosing interval
- 0.4–0.6: t½ 0.5–1x dosing interval, some troughs
- 0.3–0.4: t½ <0.5x dosing interval, significant troughs
- Use 0.5 with highVariance=true if no PK data available yet (preclinical)

FACTOR 1D — TARGET ENGAGEMENT CONFIRMATION (weight 20%):
Is there direct evidence that the drug engages its intended target in humans (or relevant model)?
- 0.9–1.0: Clinical PK/PD data confirming >80% target occupancy or validated biomarker response in humans
- 0.7–0.9: Clinical surrogate marker response confirmed (e.g. enzyme activity, receptor occupancy imaging)
- 0.5–0.7: Indirect evidence — expected clinical effect or dose-response observed but no direct engagement measure
- 0.3–0.5: Preclinical engagement only, no human data yet
- 0.1–0.3: No target engagement evidence; mechanism assumed from drug class
- Use 0.4 with highVariance=true for Preclinical/Phase 1 with no engagement data

FACTOR 1E — THERAPEUTIC WINDOW (weight 15%):
What is the ratio of the toxic dose to the effective dose? How much safety margin exists?
- 0.9–1.0: Very wide window (>100x safety margin), no dose-limiting toxicities at therapeutic doses; or biologic with no off-tumor/off-tissue toxicity
- 0.7–0.9: Wide window (10–100x), mild or manageable adverse events at therapeutic doses
- 0.5–0.7: Moderate window (3–10x), some dose-limiting toxicity requiring management
- 0.3–0.5: Narrow window (<3x), frequent Grade 3–4 toxicities at therapeutic doses, dose reductions common
- 0.1–0.3: Very narrow / no real separation (e.g., classical chemo); toxicity is the primary dose-limiting factor
- Use 0.5 with highVariance=true if no safety data available

═══════════════════════════════════════════════════════════
SUB-COMPONENT 2: TRANSLATIONAL RELIABILITY SCORE (TRS)
═══════════════════════════════════════════════════════════

FACTOR 2A — TARGET VALIDATION (weight 35%):
How well validated is this target in this disease?
- 0.9–1.0: Genetically validated (human LoF/GoF genetics link target to disease) OR approved drug hitting same target in same indication
- 0.75–0.9: Clinically validated target in different indication (proven in humans, not this disease)
- 0.5–0.7: Strong preclinical validation (multiple animal models, human tissue data)
- 0.3–0.5: Hypothesis-driven (association data, single model)
- 0.1–0.3: Novel/uncharacterized target, first-in-class limited validation

FACTOR 2B — INDICATION-MECHANISM FIT (weight 30%):
How central is this target to the disease pathology being treated?
- 0.9–1.0: Target is the primary disease driver, no redundancy, biomarker-selected patients
- 0.7–0.9: Target is primary driver, some pathway redundancy, unselected patients
- 0.5–0.7: Target is secondary driver or downstream
- 0.2–0.4: Target is peripheral or compensatory
- Add +0.10 bonus (cap at 1.0) if patients are biomarker-selected for target relevance

FACTOR 2C — MODALITY FIT TO TARGET (weight 20%):
How well matched is the drug's modality (small molecule, mAb, ADC, gene therapy, etc.) to the biology of the target?
- 0.9–1.0: Modality is the gold standard for this target class (e.g., mAb for cell-surface receptor, ASO for CNS target, gene therapy for monogenic enzyme deficiency)
- 0.7–0.9: Modality is appropriate and established for this target type
- 0.5–0.7: Modality can reach the target but with known limitations (e.g., small molecule for PPI target)
- 0.3–0.5: Modality has significant access or engagement challenges for this target (e.g., small molecule for intracellular RNA, undruggable pocket)
- 0.1–0.3: Modality is poorly matched — significant biological barrier (CNS penetration, target inaccessibility, etc.)

FACTOR 2D — PRECLINICAL-TO-CLINICAL TRANSLATION RATE (weight 15%):
What is the historical success rate of this drug class/mechanism translating from preclinical to clinical success in this indication?
- 0.9–1.0: Class has >70% Phase 2→3 success rate in this indication (e.g., mAb checkpoint inhibitors in PD-L1-high tumors)
- 0.7–0.9: Class has 50–70% Phase 2→3 success rate; good but not exceptional track record
- 0.5–0.7: Class has 30–50% Phase 2→3 success rate; mixed history (some positive, some failures)
- 0.3–0.5: Class has 15–30% success rate; multiple high-profile Phase 3 failures in this indication
- 0.1–0.3: Class has <15% success rate; poor historical translation (e.g., Alzheimer's amyloid, Phase 3 sepsis trials)
- Use 0.4 if no data exists for this mechanism×indication combination

Use web_search to research this drug before scoring. Search for:
- Published PK/PD data, IC50, selectivity profile, target engagement studies
- Target validation evidence (genetics, approved drugs in class, animal models)
- Clinical data on target engagement and mechanism fit
- Therapeutic window / safety data / dose-limiting toxicities
- Historical success rates for this drug class and indication
- Any published PTRS or probability of success analyses

If data is unavailable for a factor, use score=0.4, confidence="unknown", highVariance=true.

IMPORTANT: Respond ONLY with valid JSON — no markdown, no explanation outside the JSON:
{
  "potency":           { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "selectivity":       { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "pkProfile":         { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "targetEngagement":  { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "therapeuticWindow": { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "targetValidation":  { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "indicationMechFit": { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "modalityFit":       { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false },
  "translationRate":   { "score": 0.0, "confidence": "high|medium|low|unknown", "rationale": "one sentence", "highVariance": false }
}`;

  const userMessage = `Drug: ${drug}
Mechanism of action: ${mechanism || "unknown"}
Indication: ${indication || "unknown"}
Development phase: ${phase}${sponsor ? `\nSponsor: ${sponsor}` : ""}

Search for published data on this drug's potency, selectivity, PK profile, target engagement, therapeutic window, target validation, indication-mechanism fit, modality fit, and historical translation rate. Then score all 9 factors.`;

  const raw = await callClaudeWithSearch({
    anthropicKey,
    system: systemPrompt,
    userMessage,
    maxTokens: 2000,
    maxSearches: 4,
    serperQueries: [
      `${drug} mechanism potency selectivity IC50 target engagement`,
      `${drug} ${indication} target validation clinical data safety`,
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
    targetEngagement: factor("targetEngagement"),
    therapeuticWindow: factor("therapeuticWindow"),
    targetValidation: factor("targetValidation"),
    indicationMechFit: factor("indicationMechFit"),
    modalityFit: factor("modalityFit"),
    translationRate: factor("translationRate"),
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
    let factors;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        factors = await scoreFeaturesWithClaude(
          drug, mechanism || "", indication || "", phase || "Phase 2",
          sponsor || undefined, anthropicKey
        );
        break;
      } catch (e: any) {
        const is429 = e?.message?.includes("429");
        if (attempt === 3) throw e;
        const wait = is429 ? (attempt + 1) * 20000 : 5000;
        console.warn(`[ptrs] attempt ${attempt + 1} failed (${e?.message}), waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }

    if (!factors) throw new Error("PTRS scoring failed after retries");
    const result = scoreMechanism(factors);
    const baseline = PHASE_BASELINE[phase] ?? 0.25;
    const ptrs = Math.max(0.01, Math.min(1, baseline + result.ptrsAdjustment));
    const phaseBenchmark = computePercentile(ptrs, phase || "Phase 2");

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
      phaseBenchmark,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "PTRS scoring failed" });
  }
}
