// ─── Regulatory-designation pin (tau reproducibility, Part 1) ───────────────────
//
// A drug's FDA expedited-program / exclusivity designations (Fast Track,
// Breakthrough, Accelerated Approval, Orphan) are FACTS in FDA records / official
// press releases — they must NOT flip run-to-run the way a free LLM guess does
// (tau swung btd↔standard across identical runs, applying a bar-ease it never
// earned). This module resolves the regulatory context DETERMINISTICALLY from a
// factual registry, and maps each designation to its CORRECT, specific engine
// effect. Same discipline as the per-indication comparator pin (indication-
// benchmarks.ts): pin to sources, default conservatively, never to a P target.
//
// PURE, no I/O.

import type { RegulatoryContext } from "./ptrs-trial";

// FDA designations we encode. Each confers a DIFFERENT, specific benefit — they are
// NOT interchangeable. Fast Track = rolling review only (no bar ease, no approval
// bump); Breakthrough = eased evidentiary bar + approval uplift; Accelerated =
// surrogate-endpoint pathway; Orphan = smaller-n flexibility + exclusivity.
export type Designation = "fast_track" | "breakthrough" | "accelerated" | "orphan";

export type RegPin = {
  context: RegulatoryContext;
  confirmed: boolean;
  designations: Designation[];
  provenance: string;
};

// Deterministic FACTUAL registry, keyed by normalized asset name. Records only
// designations CONFIRMED from FDA records / official company press releases. An
// asset ABSENT here resolves to "standard" — we never credit an unconfirmed,
// run-to-run-flipping designation. Extend by adding an asset once its designations
// are verified from source; this is a factual lookup for ANY asset, not a P target
// and not a tau special-case.
const DESIGNATION_REGISTRY: Record<string, { designations: Designation[]; note: string }> = {
  "bms-986446": {
    designations: ["fast_track"],
    note: "FDA Fast Track (granted Oct 2025) for early Alzheimer's disease — BMS-986446 / PRX005; no Breakthrough or Accelerated Approval on record",
  },
};

function normalizeAsset(asset?: string): string {
  return (asset || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Parse source-backed designation text (FDA/press) into codes. Used ONLY when a
 * caller passes designations it has independently confirmed — NOT the raw LLM
 * regulatory guess (which is the thing that flips). Deterministic given the text.
 */
export function parseDesignations(raw?: string[] | string): Designation[] {
  const text = (Array.isArray(raw) ? raw.join(" ") : (raw || "")).toLowerCase();
  const out: Designation[] = [];
  if (/breakthrough|\bbtd\b/.test(text)) out.push("breakthrough");
  if (/accelerated\s+approval/.test(text)) out.push("accelerated");
  if (/orphan/.test(text)) out.push("orphan");
  if (/fast[\s-]?track/.test(text)) out.push("fast_track");
  return out;
}

/**
 * Map a CONFIRMED designation set to the RegulatoryContext, applying each
 * designation's correct benefit. Precedence mirrors how the engine encodes
 * benefits (strongest bar-ease/approval-uplift wins): BTD+orphan > BTD >
 * accelerated > orphan > fast_track > standard. Crucially, a bare Fast Track
 * resolves to "fast_track" (rolling review only), NEVER to "btd".
 */
export function designationsToContext(ds: Designation[]): RegulatoryContext {
  const has = (d: Designation) => ds.includes(d);
  if (has("breakthrough") && has("orphan")) return "btd_orphan";
  if (has("breakthrough")) return "btd";
  if (has("accelerated")) return "accelerated";
  if (has("orphan")) return "orphan";
  if (has("fast_track")) return "fast_track";
  return "standard";
}

/**
 * Deterministically resolve an asset's regulatory context. Registry-confirmed
 * designations govern; a caller-supplied source-backed designation list is the
 * secondary path; otherwise default to "standard" (no unearned benefit). The same
 * asset always resolves to the same context — no run-to-run flip.
 */
export function resolveRegulatoryContext(opts: {
  asset?: string;
  confirmedDesignations?: string[] | string;
}): RegPin {
  const reg = DESIGNATION_REGISTRY[normalizeAsset(opts.asset)];
  if (reg) {
    return {
      context: designationsToContext(reg.designations),
      confirmed: true,
      designations: reg.designations,
      provenance: `pinned: ${reg.note}`,
    };
  }
  const parsed = parseDesignations(opts.confirmedDesignations);
  if (parsed.length) {
    return {
      context: designationsToContext(parsed),
      confirmed: true,
      designations: parsed,
      provenance: `confirmed from source: ${parsed.join(", ")}`,
    };
  }
  return {
    context: "standard",
    confirmed: false,
    designations: [],
    provenance: "standard: no FDA designation confirmed from source (deterministic default — an unconfirmed designation earns no engine benefit)",
  };
}
