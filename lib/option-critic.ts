// ─── Option B critic (LLM half) — shared types + the deterministic response gate ──────────────
//
// The deterministic core (nicheProvenance.intensity + flag-market-intensity / flag-joint-band-top)
// NAMES the joint market posture; this module carries the reasoning critic that ARGUES whether the
// cited comparators jointly support it (the one thing deterministic code cannot do: "Kalydeco's
// premium came with a curative label — a symptomatic add-on rarely holds both the premium AND the
// share").
//
// §1.4 no-leak, enforced STRUCTURALLY: the critique type carries NO numeric field, so nothing the
// LLM says can reach a computation even by accident — verdict is a checked enum, everything else is
// display-only prose. validateCritiques() builds FRESH objects (unknown fields cannot survive) and
// resolve-or-flags every drop/trim (§1.5). This module imports nothing from the compute engine.

export type OptionCritiqueVerdict = "supported" | "partially-supported" | "unsupported";

export type OptionCritique = {
  optionId: string;
  verdict: OptionCritiqueVerdict;
  reasoning: string;                                        // 2–4 sentences of joint-plausibility argument
  leverNotes?: { wac?: string; share?: string; count?: string }; // optional one-liner per lever
};

export type CritiqueValidation = {
  critiques: OptionCritique[];
  flags: string[]; // every dropped/trimmed item, named ("requested X; used Y because Z")
};

const VERDICTS: OptionCritiqueVerdict[] = ["supported", "partially-supported", "unsupported"];
const REASONING_MAX = 900;
const LEVER_NOTE_MAX = 300;

function capped(s: string, max: number, what: string, flags: string[]): string {
  const t = s.trim();
  if (t.length <= max) return t;
  flags.push(`${what} exceeded ${max} chars — truncated`);
  return t.slice(0, max).trimEnd() + "…";
}

/** Gate the raw LLM output. Accepts either a bare array or { critiques: [...] }. */
export function validateCritiques(raw: unknown, requestedIds: string[]): CritiqueValidation {
  const flags: string[] = [];
  const arr: unknown = Array.isArray(raw) ? raw : (raw as { critiques?: unknown })?.critiques;
  if (!Array.isArray(arr)) {
    return { critiques: [], flags: ["critic response was not a critique array — dropped entirely"] };
  }
  const allowed = new Set(requestedIds);
  const seen = new Set<string>();
  const critiques: OptionCritique[] = [];
  for (const item of arr) {
    const it = item as Record<string, unknown>;
    const id = typeof it?.optionId === "string" ? it.optionId.trim() : "";
    if (!id || !allowed.has(id)) {
      flags.push(`critique for unknown option "${id || "(missing id)"}" — dropped (not in the request)`);
      continue;
    }
    if (seen.has(id)) {
      flags.push(`duplicate critique for option "${id}" — kept the first, dropped the rest`);
      continue;
    }
    const verdict = it.verdict;
    if (typeof verdict !== "string" || !VERDICTS.includes(verdict as OptionCritiqueVerdict)) {
      flags.push(`option "${id}": verdict "${String(verdict)}" is not one of ${VERDICTS.join("/")} — dropped`);
      continue;
    }
    const reasoningRaw = typeof it.reasoning === "string" ? it.reasoning.trim() : "";
    if (!reasoningRaw) {
      flags.push(`option "${id}": no reasoning text — dropped (a verdict without an argument is not a critique)`);
      continue;
    }
    const out: OptionCritique = {
      optionId: id,
      verdict: verdict as OptionCritiqueVerdict,
      reasoning: capped(reasoningRaw, REASONING_MAX, `option "${id}" reasoning`, flags),
    };
    const ln = it.leverNotes as Record<string, unknown> | undefined;
    if (ln && typeof ln === "object") {
      const notes: NonNullable<OptionCritique["leverNotes"]> = {};
      for (const k of ["wac", "share", "count"] as const) {
        if (typeof ln[k] === "string" && (ln[k] as string).trim()) {
          notes[k] = capped(ln[k] as string, LEVER_NOTE_MAX, `option "${id}" leverNotes.${k}`, flags);
        }
      }
      if (Object.keys(notes).length) out.leverNotes = notes;
    }
    seen.add(id);
    critiques.push(out);
  }
  return { critiques, flags };
}
