// ─── Per-indication LOA from the indication's OWN remaining path (4.5 v1) ─────────────────────
//
// THE GAP THIS CLOSES (live 8/7, taladegib): every non-lead indication inherited the LEAD plan's
// P(approval). The stalled solid-tumours row carried the IPF program's 29% — a probability computed
// from WHISTLE-PF's design — when its own reality is "Phase 2 completed, Phase 3 not started".
// A row's P must be derived from ITS OWN remaining development path.
//
// v1 is deliberately deterministic and zero-API: LOA (likelihood of approval) from the indication's
// current phase, using PUBLISHED phase-transition rates (§1.3 — pinned to literature, never tuned):
//
//   BIO / Informa Pharma Intelligence / QLS Advisors, "Clinical Development Success Rates and
//   Contributing Factors 2011–2020" (Feb 2021; 12,728 phase transitions):
//     Overall:  Ph1→2 52.0% · Ph2→3 28.9% · Ph3→filing 57.8% · filing→approval 90.6%
//               (products reproduce the report's own LOA: from Ph1 7.9%, from Ph2 15.1% ✓)
//     Oncology: Ph1→2 48.8% · Ph2→3 24.6% · Ph3→filing 47.7% · filing→approval ~90.6%
//               (product from Ph1 ≈ 5.2% vs the report's 5.3% ✓)
//   Cross-check: Wong/Siah/Lo 2019 (Biostatistics) put oncology Ph1→approval at 3.4% on 2000–2015
//   data — LOWER than BIO's 2011–2020. We pin to BIO (newer window, transition-structured); the
//   divergence is documented here, not hidden.
//
// SEMANTICS: LOA from phase X = P(approval | program currently at phase X, prosecuted normally).
// The Ph2→3 transition rate already contains "completed Phase 2 but never advanced" attrition —
// which is exactly the taladegib solid-tumours situation — so for a stalled row this is a CEILING
// (normal-prosecution assumption), and the 4.6 stalled/discontinued flag stays alongside.
//
// v1 limits (documented, not hidden): no mechanism-class haircut on secondary rows (slightly
// optimistic; the lead's haircut lives in its dev plan), no TA table beyond oncology vs overall
// (calibration extension), no per-indication cost path. Mechanism read-through is the v2 axis.

export type LoaPhaseBucket = "phase1" | "phase2" | "phase3" | "filed" | "approved";

type Transitions = { phase1: number; phase2: number; phase3: number; reg: number };

// BIO/Informa/QLS 2011–2020 (see header). "overall" = all-indication pooled rates.
const TRANSITIONS: Record<"overall" | "oncology", Transitions> = {
  overall:  { phase1: 0.520, phase2: 0.289, phase3: 0.578, reg: 0.906 },
  oncology: { phase1: 0.488, phase2: 0.246, phase3: 0.477, reg: 0.906 },
};

// Typical years from "currently at phase X" to launch — the SAME heuristic family the trial-based
// launch estimate uses (pages/api/auto-value.ts inferredLaunchYear: Ph1 +7, Ph2 +5, Ph3 +3, filed +1).
const YEARS_TO_LAUNCH: Record<LoaPhaseBucket, number> = {
  phase1: 7, phase2: 5, phase3: 3, filed: 1, approved: 0,
};

/** Loose phase parse. Order matters: "Phase 1/2" reads as phase1 (earlier = lower LOA = conservative). */
export function parseLoaPhase(phase: string | undefined | null): LoaPhaseBucket | null {
  if (!phase) return null;
  const s = phase.toLowerCase();
  if (/approved|marketed/.test(s)) return "approved";
  if (/filed|nda|bla|submission|registration\b/.test(s)) return "filed";
  if (/phase\s*1|ph\s*1|\bp1\b/.test(s)) return "phase1";
  if (/phase\s*2|ph\s*2|\bp2\b/.test(s)) return "phase2";
  if (/phase\s*3|ph\s*3|\bp3\b/.test(s)) return "phase3";
  return null;
}

export type IndicationLoa = {
  p: number;              // LOA from the parsed phase (product of remaining transitions)
  phaseBucket: LoaPhaseBucket;
  taBucket: "overall" | "oncology";
  basis: string;          // the citation + arithmetic, display-ready
  minLaunchYear: number;  // earliest credible launch: now + typical remaining path duration
};

/**
 * LOA for an indication from its own remaining path. `isOncology` comes from the caller's TA
 * inference (inferTherapeuticArea(ind.name) === "oncology"); everything else uses the pooled rates
 * (a TA-specific table is a documented calibration extension, not something to invent here).
 * Returns null when the phase cannot be parsed — the caller keeps legacy behavior and flags.
 */
export function indicationLoa(phase: string | undefined | null, isOncology: boolean, asOfYear?: number): IndicationLoa | null {
  const bucket = parseLoaPhase(phase);
  if (!bucket) return null;
  const ta = isOncology ? "oncology" : "overall";
  const t = TRANSITIONS[ta];
  const chain: Array<[string, number]> =
    bucket === "phase1" ? [["Ph1→2", t.phase1], ["Ph2→3", t.phase2], ["Ph3→filing", t.phase3], ["approval", t.reg]] :
    bucket === "phase2" ? [["Ph2→3", t.phase2], ["Ph3→filing", t.phase3], ["approval", t.reg]] :
    bucket === "phase3" ? [["Ph3→filing", t.phase3], ["approval", t.reg]] :
    bucket === "filed"  ? [["approval", t.reg]] :
    [];
  const p = chain.reduce((acc, [, v]) => acc * v, 1);
  const arith = chain.length
    ? chain.map(([label, v]) => `${label} ${(v * 100).toFixed(1)}%`).join(" × ")
    : "approved — no remaining development risk";
  return {
    p,
    phaseBucket: bucket,
    taBucket: ta,
    basis: `LOA from ${bucket} (${ta}): ${arith}${chain.length ? ` = ${(p * 100).toFixed(1)}%` : ""} — BIO/Informa/QLS phase-transition rates 2011–2020`,
    minLaunchYear: (asOfYear ?? new Date().getFullYear()) + YEARS_TO_LAUNCH[bucket],
  };
}
