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
