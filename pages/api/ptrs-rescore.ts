// /api/ptrs-rescore
// Lightweight endpoint — re-runs the PTRS scorer with user-overridden factor scores.
// Does NOT call Claude. Accepts the full factors object + phase, returns same shape
// as /api/ptrs-score so the UI can swap in the result directly.

import type { NextApiRequest, NextApiResponse } from "next";
import {
  scoreMechanism,
  UNKNOWN_FACTOR,
  type MechanismFactors,
  type FactorScore,
} from "../../lib/ptrs-mechanism-scorer";

// ─── Phase baseline + benchmark ranges (mirrored from ptrs-score.ts) ──────────

const PHASE_BASELINE: Record<string, number> = {
  Preclinical: 0.07,
  "Phase 1": 0.14,
  "Phase 2": 0.25,
  "Phase 3": 0.55,
  Filed: 0.85,
  Approved: 1.0,
};

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

// Coerce a raw factor object from the request into a valid FactorScore
function coerceFactor(f: any): FactorScore {
  if (!f || typeof f.score !== "number") return UNKNOWN_FACTOR;
  return {
    score: Math.max(0, Math.min(1, f.score)),
    confidence: ["high", "medium", "low", "unknown"].includes(f.confidence) ? f.confidence : "unknown",
    rationale: f.rationale || "Score overridden by user.",
    highVariance: !!f.highVariance,
  };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { factors: rawFactors, phase } = req.body;
  if (!rawFactors) return res.status(400).json({ error: "factors required" });

  const factors: MechanismFactors = {
    potency: coerceFactor(rawFactors.potency),
    selectivity: coerceFactor(rawFactors.selectivity),
    pkProfile: coerceFactor(rawFactors.pkProfile),
    targetEngagement: coerceFactor(rawFactors.targetEngagement),
    therapeuticWindow: coerceFactor(rawFactors.therapeuticWindow),
    targetValidation: coerceFactor(rawFactors.targetValidation),
    indicationMechFit: coerceFactor(rawFactors.indicationMechFit),
    modalityFit: coerceFactor(rawFactors.modalityFit),
    translationRate: coerceFactor(rawFactors.translationRate),
  };

  const result = scoreMechanism(factors);
  const baseline = PHASE_BASELINE[phase] ?? 0.25;
  const ptrs = Math.max(0.01, Math.min(1, baseline + result.ptrsAdjustment));
  const ptrsCI = {
    lower: Math.max(0.01, ptrs - result.ciHalfWidth),
    upper: Math.min(0.99, ptrs + result.ciHalfWidth),
  };
  const phaseBenchmark = computePercentile(ptrs, phase || "Phase 2");

  return res.status(200).json({
    ptrs,
    ptrsCI,
    baseline,
    ptrsAdjustment: result.ptrsAdjustment,
    ips: result.ips,
    trs: result.trs,
    mss: result.mss,
    divergence: result.divergence,
    variance: result.variance,
    factors: result.factors,
    summary: result.summary,
    phaseBenchmark,
    overridden: true,
  });
}
