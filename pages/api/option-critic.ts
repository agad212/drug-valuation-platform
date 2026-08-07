// ─── Option B critic (LLM half) — joint comp-plausibility reviewer ────────────────────────────
//
// POST /api/option-critic
// One BATCHED call per valuation shape: receives the ENGINE-COMPUTED niche provenance for every
// option carrying nicheProvenance.intensity, and returns a prose verdict per option on whether the
// cited comparators JOINTLY support the combined posture (WAC × share × count). The deterministic
// core already named the multiple (flag-market-intensity) and the fully-loaded configuration
// (flag-joint-band-top); this is the half only a reasoner can do — arguing from the comps'
// commercial reality (label strength, competitive field, whether the comp held price AND share
// simultaneously).
//
// §1.4 no-leak: the response is gated by validateCritiques() — enum verdict + display-only prose,
// no numeric field exists on the type, nothing here re-enters any computation. Advisory only.
// Uses Sonnet (reasoning over named comps from parametric knowledge — no web search, one call).

import type { NextApiRequest, NextApiResponse } from "next";
import { validateCritiques } from "../../lib/option-critic";
import { logStart, logEnd } from "../../lib/endpoint-timing";

const MODEL = "claude-sonnet-4-6";

type LeverClaim = { value: number; comp: string | null; sourced: boolean; inBand: boolean };

type CriticOption = {
  id: string;
  name: string;
  basis?: string | null; // the option's nicheMarketBasis (the LLM's original market rationale)
  wac: LeverClaim;
  share: LeverClaim;
  eligible?: {
    value: number | null;
    cited: number | null;
    bound: number | null;
    clamped: boolean;
    unbounded: boolean;
  } | null;
  intensity: {
    revenuePerEligibleRatio: number;
    wacMultiple: number;
    shareMultiple: number;
    wacBandPos: number;
    shareBandPos: number;
  };
};

type RequestBody = {
  drug?: string;
  phase?: string;
  mechanism?: string;
  indication?: string;
  options: CriticOption[];
};

const fmtUsd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pos = (p: number) => (p >= 2 / 3 ? "top third" : p >= 1 / 3 ? "middle" : "bottom third");

function describeOption(o: CriticOption): string {
  const lines = [
    `Option id "${o.id}" — "${o.name}"`,
    `  Stated market rationale: ${o.basis?.trim() || "(none given)"}`,
    `  WAC: ${fmtUsd(o.wac.value)}/yr — ${o.wac.sourced ? `cited to comp "${o.wac.comp ?? "unnamed"}"` : "UNSOURCED (held at the labeled bounded default)"}; ${pos(o.intensity.wacBandPos)} of its plausibility band; ×${o.intensity.wacMultiple.toFixed(1)} the broad case's price`,
    `  Peak share of eligible niche: ${o.share.value.toFixed(0)}% — ${o.share.sourced ? `cited to comp "${o.share.comp ?? "unnamed"}"` : "UNSOURCED (held at the labeled bounded default)"}; ${pos(o.intensity.shareBandPos)} of its band; ×${o.intensity.shareMultiple.toFixed(1)} the broad case's penetration`,
  ];
  if (o.eligible) {
    const e = o.eligible;
    if (e.clamped) lines.push(`  Eligible count: ${e.value?.toLocaleString("en-US")} — cited ${e.cited?.toLocaleString("en-US")} EXCEEDED the base-population bound ${e.bound?.toLocaleString("en-US")} and was CLAMPED to it (the count is pinned at its ceiling)`);
    else if (e.unbounded) lines.push(`  Eligible count: ${e.value?.toLocaleString("en-US")} — cited with NO base pool to contain it against (unbounded, flagged)`);
    else lines.push(`  Eligible count: ${e.value?.toLocaleString("en-US")}${e.bound != null ? ` (within its containment bound ${e.bound.toLocaleString("en-US")})` : ""}`);
  }
  lines.push(`  JOINT posture: ×${o.intensity.revenuePerEligibleRatio.toFixed(1)} the broad case's revenue per eligible patient`);
  return lines.join("\n");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const __t0 = logStart("option-critic");

  const { drug, phase, mechanism, indication, options } = (req.body ?? {}) as RequestBody;
  const valid = Array.isArray(options)
    ? options.filter((o) => o && typeof o.id === "string" && o.intensity && o.wac && o.share)
    : [];
  if (!valid.length) {
    logEnd("option-critic", __t0, "error", { reason: "no-flagged-options" });
    return res.status(400).json({ error: "No options with market-intensity provenance in the request" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logEnd("option-critic", __t0, "error", { reason: "no-api-key" });
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  }

  const requestedIds = valid.map((o) => o.id);

  const prompt = `You are a skeptical pharma commercial due-diligence reviewer. A valuation model proposes precision-medicine reshape option(s) for ${drug || "a drug asset"}${indication ? ` in ${indication}` : ""}${mechanism ? ` (${mechanism})` : ""}${phase ? `, currently ${phase}` : ""}. Each option claims a niche market posture: an annual price (WAC), a peak share of the eligible niche, and an eligible-patient count.

Every individual value below has ALREADY been checked by deterministic code — cited to a comparator, held inside a literature plausibility band, and the patient count contained against the base population. Do NOT re-litigate any individual value. Your job is the one thing code cannot do: judge whether the cited comparators JOINTLY support the COMBINED posture — a comp can legitimately anchor a premium price, or a high share, without ever having held both simultaneously.

${valid.map(describeOption).join("\n\n")}

How to reason (from the comparators' actual commercial reality, using your knowledge of them):
- Did the named comp achieve its premium price AND its share SIMULTANEOUSLY, or is the option borrowing the price from one context and the share from another?
- Label strength: a curative or disease-modifying label (e.g. a CFTR modulator) holds pricing power a symptomatic or add-on therapy rarely does. Is this asset's profile comparable to the comp's?
- Competitive field: what the comp faced at launch vs what this asset will face.
- Payer reality: at the stated WAC, will payers gatekeep the niche below the claimed share?
- An UNSOURCED value rests on a labeled default, not a comp — say so rather than inventing support for it.
- A count PINNED AT ITS CEILING plus top-of-band price and share is the posture a motivated narrative reaches for — weigh that joint configuration explicitly.

Verdict per option:
- "supported" — the named comps genuinely exhibited the joint posture and the asset's profile is comparable.
- "partially-supported" — the comps support the components but not the joint multiple, or only with material caveats.
- "unsupported" — the comps' actual history contradicts the joint claim.

HARD RULES:
- NEVER propose replacement numbers, adjusted multiples, corrected revenue, or a "more realistic" figure — your output is prose judgment only. Any number you mention must be copied EXACTLY from the input above.
- Argue from the comps NAMED in the input plus their real commercial history; if you don't know a named comp, say so instead of guessing.
- reasoning: 2–4 sentences. leverNotes: optional, ONE sentence per lever.
- Respond with STRICT JSON only — no prose outside the JSON, no markdown fences:
{"critiques":[{"optionId":"<id from input>","verdict":"supported|partially-supported|unsupported","reasoning":"...","leverNotes":{"wac":"...","share":"...","count":"..."}}]}`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        // Headroom for 3-4 flagged options with full reasoning + lever notes: a clipped JSON is a
        // parse failure and the whole advisory layer goes silent — the worst failure mode here.
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("[option-critic] Claude error:", errText.slice(0, 300));
      logEnd("option-critic", __t0, "error", { reason: "claude-api", status: apiRes.status });
      return res.status(502).json({ error: "Claude API error" });
    }

    const data = (await apiRes.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();

    // Tolerate a fenced or prefixed reply: take the outermost {...} slice, then gate it.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    let parsed: unknown = null;
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { parsed = null; }
    }
    const gated = validateCritiques(parsed, requestedIds);
    logEnd("option-critic", __t0, "ok", { requested: requestedIds.length, returned: gated.critiques.length, gateFlags: gated.flags.length });
    return res.status(200).json(gated);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[option-critic] Failed:", msg);
    logEnd("option-critic", __t0, "error", { reason: "exception" });
    return res.status(500).json({ error: msg });
  }
}
