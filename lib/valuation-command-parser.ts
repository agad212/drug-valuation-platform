// lib/valuation-command-parser.ts
//
// DETERMINISTIC (no-LLM) parse of PRECISE field commands into engine INPUTS. Pure; imports no compute.
// Returns null when the text is not a recognized command (→ the caller falls through to the
// conversational/LLM path). It maps LANGUAGE → an input field only; it computes NO valuation number.
// The parsed update still passes through validateValuationInputs before any setter, so an out-of-range
// parse is rejected there — the parser never sets state directly.

export type ParsedCommand = { updates: Record<string, number | string>; echo: string };

function parseMoney(s: string): number | null {
  const m = s.match(/\$?\s*([\d][\d,]*\.?\d*)\s*(billion|bn|b|million|mm|m|thousand|k)?/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] || "").toLowerCase();
  let mult = 1;
  if (unit === "billion" || unit === "bn" || unit === "b") mult = 1e9;
  else if (unit === "million" || unit === "mm" || unit === "m") mult = 1e6;
  else if (unit === "thousand" || unit === "k") mult = 1e3;
  return num * mult;
}

function parsePct(s: string): number | null {
  const m = s.match(/(\d+\.?\d*)\s*(%)?/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  if (m[2] === "%") return num / 100;      // "12%" → 0.12
  if (num > 1 && num <= 100) return num / 100; // bare "12" → 12%
  return num;                              // "0.12" → 0.12
}

function parseYear(s: string): number | null {
  const m = s.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

function normalizePhase(s: string): string | null {
  const t = s.toLowerCase();
  if (/\bpreclinical\b/.test(t)) return "Preclinical";
  if (/\bfiled\b/.test(t)) return "Filed";
  if (/\bapproved\b/.test(t)) return "Approved";
  if (/\bphase\s*(3|iii)\b/.test(t)) return "Phase 3";
  if (/\bphase\s*(2|ii)\b/.test(t)) return "Phase 2";
  if (/\bphase\s*(1|i)\b/.test(t)) return "Phase 1";
  return null;
}

const pctEcho = (label: string, v: number) => `Set ${label} to ${+(v * 100).toFixed(2)}%.`;
const moneyEcho = (label: string, v: number) =>
  `Set ${label} to ${v >= 1e9 ? `$${+(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${v.toLocaleString()}`}.`;

// Ordered so more-specific keywords win (e.g. "dev cost" and "peak sales" before generic matches).
// Each entry: a keyword test, the field, and how to extract the value.
type Field = { key: string; kw: RegExp; kind: "pct" | "money" | "year" | "phase"; label: string };
const FIELDS: Field[] = [
  { key: "peakSales", kw: /\bpeak(\s+sales)?\b/, kind: "money", label: "peak sales" },
  { key: "devCostPV", kw: /\bdev(elopment)?\s*cost\b/, kind: "money", label: "dev cost" },
  { key: "discountRate", kw: /\bdiscount(\s+rate)?\b/, kind: "pct", label: "discount rate" },
  { key: "cogsPct", kw: /\bcogs\b/, kind: "pct", label: "COGS" },
  { key: "taxRate", kw: /\btax(\s+rate)?\b/, kind: "pct", label: "tax rate" },
  { key: "workingCapitalPct", kw: /\bworking\s*capital\b/, kind: "pct", label: "working capital" },
  { key: "avgRoyalty", kw: /\broyalty\b/, kind: "pct", label: "royalty" },
  { key: "ptrs", kw: /\b(ptrs|override\s+p\b|p\(approval\)|probability\s+of\s+(approval|success)|approval\s+probability)\b/, kind: "pct", label: "P(approval) override" },
  { key: "launchYear", kw: /\blaunch(\s+year)?\b/, kind: "year", label: "launch year" },
  { key: "loeYear", kw: /\b(loe(\s+year)?|loss\s+of\s+exclusivity)\b/, kind: "year", label: "LOE year" },
  { key: "phase", kw: /\bphase\b|\bpreclinical\b|\bfiled\b|\bapproved\b/, kind: "phase", label: "phase" },
];

export function parseValuationCommand(text: string): ParsedCommand | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const t = text.trim().toLowerCase();

  // Only engage on an intent to SET/change a value (avoids hijacking questions like "what drives rNPV?").
  const looksLikeSet = /\b(set|change|update|make|use|adjust|to)\b/.test(t) || /=|:\s*\$?\d/.test(t);
  // A bare year alone (e.g. "launch 2028") is also a set even without a verb.
  if (!looksLikeSet && !/\b(19|20)\d{2}\b/.test(t) && !/\d/.test(t)) return null;

  for (const f of FIELDS) {
    if (!f.kw.test(t)) continue;
    if (f.kind === "phase") {
      const p = normalizePhase(t);
      if (p != null) return { updates: { phase: p }, echo: `Set phase to ${p}.` };
      continue;
    }
    if (f.kind === "year") {
      const y = parseYear(t);
      if (y != null) return { updates: { [f.key]: y }, echo: `Set ${f.label} to ${y}.` };
      continue;
    }
    if (f.kind === "money") {
      const n = parseMoney(t);
      if (n != null) return { updates: { [f.key]: n }, echo: moneyEcho(f.label, n) };
      continue;
    }
    // pct
    const p = parsePct(t);
    if (p != null) return { updates: { [f.key]: p }, echo: pctEcho(f.label, p) };
  }
  return null;
}
