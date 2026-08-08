// ─── AI-elicitation core (module 1: the dev-plan interview) ────────────────────────────────────
//
// Recasts the LLM layer as an SME under facilitated elicitation (the user's SOA training doctrine):
// the AI states extremes BEFORE central values, gives ranges instead of raw variances, answers a
// consistency cross-check in a second framing, and a second AI pass (the checker) audits the
// RATIONALE — never the number. This module is the deterministic side: unit conversions, coherence
// gates, and the checker-response gate. It imports nothing from the compute engine (§1.4) and emits
// nothing an engine could mistake for a computed value except the σ² conversion below, which is a
// pure, cited formula on elicited inputs.

// Elicited bounds are interpreted as the 15th/85th percentiles, NEVER absolutes: the cost-risk
// literature's convention (experts rarely cover more than ~70% of the true range — "treat bounds as
// the 15/85 percent interpretation"). For a normal, z(0.85) ≈ 1.0364, so the elicited width spans
// 2×1.0364σ. This lets the AI-SME state a RANGE (natural units) and deterministic code derive the
// variance — replacing the old practice of asking the LLM to emit a raw σ² it cannot calibrate.
const Z_85 = 1.0364;

/** σ² from an elicited 15/85 range. Returns null (caller keeps legacy behavior) unless 0<low<high<1. */
export function sigma2FromBounds(low: unknown, high: unknown): number | null {
  if (typeof low !== "number" || typeof high !== "number") return null;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  if (!(low > 0 && high < 1 && high > low)) return null;
  const sigma = (high - low) / (2 * Z_85);
  return sigma * sigma;
}

/** Ordering coherence for an elicited (low, central, high) triple. Null = coherent. */
export function rangeIncoherence(low: number | undefined, central: number, high: number | undefined, what: string): string | null {
  if (low != null && central < low) return `${what}: central ${central} sits BELOW the stated low ${low} — incoherent elicitation, range ignored`;
  if (high != null && central > high) return `${what}: central ${central} sits ABOVE the stated high ${high} — incoherent elicitation, range ignored`;
  if (low != null && high != null && low > high) return `${what}: low ${low} exceeds high ${high} — incoherent elicitation, range ignored`;
  return null;
}

// Cross-check tolerance: the same belief elicited through two framings (a probability vs an
// "N of 10 comparable programs" frequency) should roughly agree; the literature's warning is that
// mathematically equivalent framings often DON'T — that disagreement is signal, not noise.
// 0.15 is a HAND-SET provisional threshold (labeled, like B1) pending calibration.
export const CROSS_CHECK_TOLERANCE = 0.15;

export function crossCheckDisagreement(p: number, outOf10: unknown): string | null {
  if (typeof outOf10 !== "number" || !Number.isFinite(outOf10) || outOf10 < 0 || outOf10 > 10) return null;
  const pFromFreq = outOf10 / 10;
  if (Math.abs(p - pFromFreq) < CROSS_CHECK_TOLERANCE) return null;
  return `two framings of the same belief disagree: stated probability ${(p * 100).toFixed(0)}% vs frequency framing "${outOf10} of 10 comparable programs" (${(pFromFreq * 100).toFixed(0)}%) — reconcile before trusting either (±${CROSS_CHECK_TOLERANCE * 100}% provisional tolerance)`;
}

// ── Module 3: revenue-elicitation coherence rails (pure arithmetic, display-only) ───────────────
// Moved here from the API route so the tolerances are NAMED constants (calibratable in one place),
// the checks are unit-testable, and the client imports the same rails instead of re-implementing
// them with different hardcoded numbers (8/8 code-review finding).

/** Finite positive number guard (NaN/strings/zero excluded). */
export const pos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
/** Finite non-negative number guard — a legitimate elicited p05 of exactly 0 must NOT be dropped. */
export const nonNeg = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

// All HAND-SET provisional rails (labeled in the messages) pending calibration.
export const TAM_RATIO_TOL = 0.33;          // TAM-vs-patients×price and peak-vs-TAM×pen: ratio outside [1-tol, 1+tol]
export const NARROW_SPREAD_FLOOR = 0.4;     // (p95−p05)/base below this → overconfidence rail
export const ROW_DIVERGENCE_RATIO = 2;      // row peak vs deep-dive peak ≥2× or ≤0.5× → two AI passes disagree
export const CROWDED_FIELD_MIN = 3;         // ≥3 expected non-generic competitors at launch = crowded
export const CROWDED_SHARE_MAX_PCT = 25;    // >25% share claimed against a crowded field → defend it

const ratioIncoherent = (r: number) => r > 1 + TAM_RATIO_TOL || r < 1 - TAM_RATIO_TOL;

/** Row-vs-deep-dive peak divergence (the 8/8 $2.45B-vs-$650M finding). Null = no divergence. */
export function rowDivergenceRatio(rowPeakM: unknown, deepDivePeakM: unknown): number | null {
  if (!pos(rowPeakM) || !pos(deepDivePeakM)) return null;
  const r = rowPeakM / deepDivePeakM;
  return r >= ROW_DIVERGENCE_RATIO || r <= 1 / ROW_DIVERGENCE_RATIO ? r : null;
}

/** Deterministic coherence checks on one indication's elicited market arithmetic. §1.5: incoherence is NAMED, never silently fixed. */
export function revenueCoherenceFlags(a: {
  peakSalesM?: number; bearM?: number; bullM?: number;
  competitorsAtLaunch?: { name: string; status: string; note?: string }[];
  marketContext?: {
    tamM?: number | null; penetrationPct?: number | null; pricingPerYear?: number | null; eligiblePatients?: number | null;
    epi?: { prevalence?: number | null; diagnosedPct?: number | null; treatedPct?: number | null; accessiblePct?: number | null; basis?: string | null } | null;
  };
}, epiPin?: { usDiagnosedLow: number; usDiagnosedHigh: number; treatedPctLow: number; treatedPctHigh: number; source: string } | null, epiGlobalToUsMax = 4): string[] {
  const f: string[] = [];
  const mc = a.marketContext ?? {};
  const { tamM, penetrationPct, pricingPerYear, eligiblePatients } = mc;

  // ── Module 3c: the epi FUNNEL must multiply out to the stated count (pure arithmetic) ──────────
  const pct = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 100;
  const epi = mc.epi;
  if (epi != null && pos(epi.prevalence) && pct(epi.diagnosedPct) && pct(epi.treatedPct)) {
    const acc = pct(epi.accessiblePct) ? epi.accessiblePct : 100;
    const funnelCount = epi.prevalence * (epi.diagnosedPct / 100) * (epi.treatedPct / 100) * (acc / 100);
    if (pos(eligiblePatients)) {
      const r = funnelCount / eligiblePatients;
      if (r > 1 + TAM_RATIO_TOL || r < 1 - TAM_RATIO_TOL) {
        f.push(`epi funnel incoherent: ${epi.prevalence.toLocaleString("en-US")} prevalent × ${epi.diagnosedPct}% diagnosed × ${epi.treatedPct}% treated${pct(epi.accessiblePct) ? ` × ${epi.accessiblePct}% accessible` : ""} ≈ ${Math.round(funnelCount).toLocaleString("en-US")}, but eligiblePatients says ${eligiblePatients.toLocaleString("en-US")} (${r.toFixed(1)}× apart) — the funnel and the count disagree (±${Math.round(TAM_RATIO_TOL * 100)}% provisional tolerance)`);
      }
    }
  } else if (pos(eligiblePatients)) {
    f.push("epi funnel not emitted — the eligible-patient count is a bare assertion (prevalence → % diagnosed → % treated → % accessible makes it checkable step by step)");
  }
  // Library anchor: the stated GLOBAL pool must sit inside the cited plausibility window
  // [US-treated low, global-to-US-max × US-treated high]. Facts before opinions.
  if (epiPin && pos(eligiblePatients)) {
    const usTreatedLow = epiPin.usDiagnosedLow * (epiPin.treatedPctLow / 100);
    const usTreatedHigh = epiPin.usDiagnosedHigh * (epiPin.treatedPctHigh / 100);
    const windowHigh = usTreatedHigh * epiGlobalToUsMax;
    if (eligiblePatients < usTreatedLow || eligiblePatients > windowHigh) {
      f.push(`LIBRARY EPI ANCHOR: stated eligible pool ${eligiblePatients.toLocaleString("en-US")} is OUTSIDE the cited plausibility window ${Math.round(usTreatedLow).toLocaleString("en-US")}–${Math.round(windowHigh).toLocaleString("en-US")} (US treated ≈ ${Math.round(usTreatedLow).toLocaleString("en-US")}–${Math.round(usTreatedHigh).toLocaleString("en-US")} from cited bands; global ≤${epiGlobalToUsMax}× US, provisional rail) — reconcile with the cited epidemiology: ${epiPin.source}`);
    }
  }

  // ── Module 3c: penetration must be defended against the AT-LAUNCH field ────────────────────────
  const compSet = Array.isArray(a.competitorsAtLaunch) ? a.competitorsAtLaunch : [];
  if (pos(tamM) && pct(penetrationPct) && compSet.length === 0) {
    f.push("at-launch competitor set not emitted — the penetration % is undefended against the field expected in the launch year (today's market is the wrong benchmark; provisional rail)");
  }
  const nonGeneric = compSet.filter((c) => c.status === "approved-incumbent" || c.status === "likely-approved-by-launch").length;
  if (pct(penetrationPct) && nonGeneric >= CROWDED_FIELD_MIN && penetrationPct > CROWDED_SHARE_MAX_PCT) {
    f.push(`penetration ${penetrationPct}% claimed against ${nonGeneric} expected non-generic competitors at launch — a >${CROWDED_SHARE_MAX_PCT}% share in a crowded field needs a named differentiation argument (provisional rail)`);
  }
  if (pos(eligiblePatients) && pos(pricingPerYear) && pos(tamM)) {
    const impliedTamM = (eligiblePatients * pricingPerYear) / 1e6;
    const r = impliedTamM / tamM;
    if (ratioIncoherent(r)) {
      f.push(`TAM arithmetic incoherent: ${eligiblePatients.toLocaleString("en-US")} patients × $${Math.round(pricingPerYear / 1000)}k/yr implies ~$${Math.round(impliedTamM).toLocaleString("en-US")}M, but tamM says $${Math.round(tamM).toLocaleString("en-US")}M (${r.toFixed(1)}× apart) — at least one of the three numbers is wrong (±${Math.round(TAM_RATIO_TOL * 100)}% provisional tolerance)`);
    }
  } else if (pos(tamM) && !pos(eligiblePatients)) {
    f.push("eligiblePatients not emitted — the TAM arithmetic is unverifiable (the 8/8 live run's $3B-TAM-vs-$12B-patient-math contradiction was only catchable with a structured count)");
  }
  if (pos(tamM) && pos(penetrationPct) && pos(a.peakSalesM)) {
    const impliedPeak = (tamM * penetrationPct) / 100;
    const r = impliedPeak / a.peakSalesM;
    if (ratioIncoherent(r)) {
      f.push(`peak arithmetic incoherent: TAM $${Math.round(tamM).toLocaleString("en-US")}M × ${penetrationPct}% implies ~$${Math.round(impliedPeak).toLocaleString("en-US")}M vs stated peak $${Math.round(a.peakSalesM).toLocaleString("en-US")}M (±${Math.round(TAM_RATIO_TOL * 100)}% provisional tolerance)`);
    }
  }
  // bearM may legitimately be 0 ("~5% chance it never really launches") — nonNeg, not pos
  // (the old `> 0` guard silently skipped ordering AND spread checks on exactly that case).
  if (nonNeg(a.bearM) && pos(a.bullM) && pos(a.peakSalesM)) {
    if (!(a.bearM < a.peakSalesM && a.peakSalesM < a.bullM)) {
      f.push(`bear/base/bull ordering violated ($${a.bearM}M / $${a.peakSalesM}M / $${a.bullM}M) — the elicited range is unusable until reconciled`);
    } else if ((a.bullM - a.bearM) / a.peakSalesM < NARROW_SPREAD_FLOOR) {
      f.push(`p05–p95 spread is only ${Math.round(((a.bullM - a.bearM) / a.peakSalesM) * 100)}% of the base — suspiciously narrow for a pre-launch asset (experts under-cover ranges; ${Math.round(NARROW_SPREAD_FLOOR * 100)}% floor is a provisional rail)`);
    }
  }
  return f;
}

// ── Checker-response gate (same structural no-leak contract as the Option B critic) ─────────────
// The checker audits RATIONALES for the classic elicitation failures (anchoring, availability,
// base-rate neglect, motivated narrative, rationale↔number arithmetic). Its findings are
// display-only prose with a checked severity enum — a fresh-object gate so nothing numeric or
// unrequested survives to the client.

export type ElicitationFinding = { severity: "high" | "medium" | "info"; message: string };

const SEVERITIES = ["high", "medium", "info"] as const;
const FINDING_MAX = 500;
const MAX_FINDINGS = 6;

export function validateElicitationFindings(raw: unknown, allowedQuantities: string[]): { findings: ElicitationFinding[]; flags: string[] } {
  const flags: string[] = [];
  const arr: unknown = Array.isArray(raw) ? raw : (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(arr)) return { findings: [], flags: ["checker response was not a findings array — dropped"] };
  const allowed = new Set(allowedQuantities);
  const findings: ElicitationFinding[] = [];
  for (const item of arr) {
    if (findings.length >= MAX_FINDINGS) { flags.push(`more than ${MAX_FINDINGS} findings — extras dropped`); break; }
    const it = item as Record<string, unknown>;
    const q = typeof it?.quantity === "string" ? it.quantity.trim() : "";
    if (!q || !allowed.has(q)) { flags.push(`finding for unknown quantity "${q || "(missing)"}" — dropped`); continue; }
    const sev = it.severity;
    if (typeof sev !== "string" || !SEVERITIES.includes(sev as ElicitationFinding["severity"])) {
      flags.push(`finding "${q}": severity "${String(sev)}" not one of ${SEVERITIES.join("/")} — dropped`);
      continue;
    }
    const msg = typeof it.message === "string" ? it.message.trim() : "";
    if (!msg) { flags.push(`finding "${q}": empty message — dropped`); continue; }
    const capped = msg.length > FINDING_MAX ? msg.slice(0, FINDING_MAX).trimEnd() + "…" : msg;
    if (msg.length > FINDING_MAX) flags.push(`finding "${q}" truncated at ${FINDING_MAX} chars`);
    findings.push({ severity: sev as ElicitationFinding["severity"], message: `AI checker — ${q}: ${capped}` });
  }
  return { findings, flags };
}
