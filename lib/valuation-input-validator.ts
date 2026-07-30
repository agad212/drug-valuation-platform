// lib/valuation-input-validator.ts
//
// THE VALIDATION CHOKE POINT for every chat/UI field adjustment. Pure + deterministic. No compute
// import (imports only the Valuation TYPE, erased at compile) — grep-provable no-leak-at-UI.
//
//   • WRITABLE_FIELDS is a WHITELIST that EXCLUDES every engine OUTPUT (no pApproval / eNPV / revenuePV /
//     rnpv / roi). A chat write can only ever set an INPUT; the number always comes from the engine.
//     Anything off the whitelist is rejected as "not a writable field".
//   • Ranges: rates in (0,1) or [0,1); money ≥ 0; years 1990–2100; phase in the allowed set. Out of
//     range → REJECT (never clamp, never set) with a surfaced reason.
//   • applyValidatedUpdates reproduces the panel setters' SIDE-EFFECTS so a chat write is byte-identical
//     to the manual path: peakSales routes to the first indication; a loeYear set clears loeBasis.

import type { Valuation } from "./types";

// The only fields a chat/UI adjustment may write. NO engine output appears here (that is the point).
export const WRITABLE_FIELDS = [
  "asset", "sponsor", "indication", "mechanism", "phase",
  "peakSales", "discountRate", "cogsPct", "taxRate", "workingCapitalPct", "avgRoyalty",
  "launchYear", "loeYear", "devCostPV", "ptrs",
] as const;

// rate bounds: discountRate & ptrs are strictly (0,1) (a 0 rate / 0 probability is degenerate); the
// cost-rate fields allow 0 (0% COGS/tax/WC/royalty is legitimate).
const RATE_BOUNDS: Record<string, { minExclusive: boolean; min: number; max: number }> = {
  discountRate: { minExclusive: true, min: 0, max: 1 },
  ptrs: { minExclusive: true, min: 0, max: 1 },
  cogsPct: { minExclusive: false, min: 0, max: 1 },
  taxRate: { minExclusive: false, min: 0, max: 1 },
  workingCapitalPct: { minExclusive: false, min: 0, max: 1 },
  avgRoyalty: { minExclusive: false, min: 0, max: 1 },
};
const MONEY_FIELDS = new Set(["peakSales", "devCostPV"]);
const YEAR_FIELDS = new Set(["launchYear", "loeYear"]);
const STRING_FIELDS = new Set(["asset", "sponsor", "indication", "mechanism"]);
const PHASES = ["", "Preclinical", "Phase 1", "Phase 2", "Phase 3", "Filed", "Approved"];

export type Rejection = { field: string; value: unknown; reason: string };
export type ValidationResult = { accepted: Record<string, any>; rejected: Rejection[] };

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const WRITABLE = new Set<string>(WRITABLE_FIELDS as readonly string[]);

export function validateValuationInputs(updates: Record<string, unknown> | null | undefined): ValidationResult {
  const accepted: Record<string, any> = {};
  const rejected: Rejection[] = [];
  for (const [key, value] of Object.entries(updates ?? {})) {
    if (!WRITABLE.has(key)) {
      rejected.push({ field: key, value, reason: "not a writable field — engine outputs are computed, never set" });
      continue;
    }
    const rb = RATE_BOUNDS[key];
    if (rb) {
      if (isNum(value) && (rb.minExclusive ? value > rb.min : value >= rb.min) && value < rb.max) accepted[key] = value;
      else rejected.push({ field: key, value, reason: `must be a decimal in ${rb.minExclusive ? "(0,1)" : "[0,1)"} — e.g. 0.12 for 12%` });
    } else if (MONEY_FIELDS.has(key)) {
      if (isNum(value) && value >= 0) accepted[key] = value;
      else rejected.push({ field: key, value, reason: "must be a number ≥ 0 (USD)" });
    } else if (YEAR_FIELDS.has(key)) {
      if (isNum(value) && Number.isInteger(value) && value >= 1990 && value <= 2100) accepted[key] = value;
      else rejected.push({ field: key, value, reason: "must be an integer year 1990–2100" });
    } else if (key === "phase") {
      if (typeof value === "string" && PHASES.includes(value)) accepted[key] = value;
      else rejected.push({ field: key, value, reason: `must be one of: ${PHASES.filter(Boolean).join(", ")}` });
    } else if (STRING_FIELDS.has(key)) {
      if (typeof value === "string") accepted[key] = value;
      else rejected.push({ field: key, value, reason: "must be a string" });
    }
  }
  return { accepted, rejected };
}

// Apply an ALREADY-VALIDATED update set to a valuation, reproducing the panel setters' side-effects so a
// chat write === the manual path. Pure — the caller wraps it in setV. This is the single transform both
// the live setter (onFieldUpdate) and the parity test use, so they cannot diverge.
export function applyValidatedUpdates(v: Valuation, accepted: Record<string, any>): Valuation {
  const next: Valuation = { ...v, ...accepted };
  if ("peakSales" in accepted && v.indications && v.indications.length) {
    // legacy top-level peakSales is a fallback; the indications drive rNPV → route to the first (matches
    // the existing chat setter's behavior).
    next.indications = v.indications.map((ind, i) => (i === 0 ? { ...ind, peakSales: accepted.peakSales } : ind));
  }
  if ("loeYear" in accepted) {
    // a manual LOE set clears loeBasis (matches the panel's LOE setter) so it isn't treated as a pinned
    // patent/exclusivity value.
    next.loeBasis = undefined;
  }
  return next;
}
