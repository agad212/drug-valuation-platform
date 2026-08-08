import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../../lib/claudeSearch";
import { runElicitationChecker } from "../../../lib/elicitation-checker";

// ─── Claude patent analysis with native web search ────────────────────────────

async function analyzeWithClaude(drugName: string, sponsor: string | undefined, indication?: string) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");

  const systemPrompt = `You are a pharmaceutical patent analyst estimating Loss of Exclusivity (LOE).

Use web_search to find patents for this drug on patents.google.com, lens.org, and worldwide.espacenet.com.

Patent hierarchy for LOE (most to least important):
1. Compound/composition patents — cover the active molecule (critical, longest protection)
2. Formulation patents — specific delivery systems
3. Method-of-use patents — therapeutic indications
4. Process patents — manufacturing (least relevant for LOE)

YOU EMIT OBSERVABLES; THE ENGINE COMPUTES DATES. Report what the patent record SAYS. Do NOT compute term
extensions, do NOT apply orphan/NCE exclusivity, and do NOT pick a final LOE year — deterministic code
applies Patent Term Extension (35 USC 156, capped at +5yr and at 14yr of effective life post-approval, and
only if the patent is still in force at approval) and the statutory exclusivity clocks.
- baseExpiry = earliest filing year + 20. Emit this RAW, with NO PTE added.
- estimatedExpiry: only if a granted term adjustment is actually documented; otherwise null.

SCOPE MATTERS MORE THAN LENGTH. For each patent, state whether it covers THE INDICATION BEING VALUED:
- A compound / composition-of-matter patent covers the molecule for ALL indications → true.
- A method-of-use patent covers ONLY its claimed indication(s). If it claims a DIFFERENT indication than the
  one being valued, set coversValuedIndication = false — it cannot protect this indication's revenue.
- A formulation patent covers only that formulation; if the commercial product uses a different form, false.

HOW LIKELY IS THIS PATENT TO ACTUALLY PROTECT REVENUE (pProtective, 0–1)? Reason about design-around risk:
- Compound patents are hard to design around → high.
- Method-of-use patents are frequently circumvented: a generic omits the patented indication from its label
  (a "skinny label", FDCA section viii carve-out) and launches for the remaining uses. BUT the Federal
  Circuit's GSK v. Teva holding stands (Supreme Court denied certiorari, May 2023), so a generic whose own
  marketing encourages the carved-out use CAN be liable for induced infringement. So judge the specifics:
  is there any OTHER approved indication to skinny-label into (if not, the carve-out is useless to a generic
  and the patent is much stronger)? Is the patented use the drug's dominant commercial use?
- ALWAYS pair pProtective with pProtectiveRationale explaining the design-around reasoning. Without a
  rationale the engine discards the number and uses its own default, so an unexplained figure is wasted.

ELICITATION PROTOCOL for pProtective — you are the expert under a facilitated probability elicitation.
Work EXTREMES FIRST, center last (anchoring runs downhill from the first number you commit to):
1. pProtectiveLow / pProtectiveHigh: your 15/85 bounds FIRST — a ~15% chance the true protective strength
   is below the low / above the high. Think about how litigation, IPR, or a design-around could surprise
   you in each direction. Experts systematically under-cover the true range; when in doubt, widen.
2. pProtective: your central value, and it MUST lie inside the bounds.
3. crossCheckOutOf10: the SAME belief in a second framing — of 10 comparable patents of this type facing
   generic challenge (Paragraph IV litigation, IPR, design-around attempts), how many actually hold and
   protect the revenue? Answer from your knowledge of litigation outcomes for this patent type — do NOT
   just convert your pProtective. Disagreement between the two framings is expected signal (it gets
   flagged for the user, not punished).
A reviewer will audit your rationale for anchoring, availability (the most recent famous case), and
base-rate neglect (compound patents mostly hold; MOU patents mostly get carved out) — write reasoning
that survives that audit.

Respond ONLY with valid JSON:
{
  "loeMin": <integer year, conservative — no PTE>,
  "loeMax": <integer year, optimistic — with full PTE on key patents>,
  "bestEstimate": <integer year, most likely LOE>,
  "confidence": "high" | "medium" | "low",
  "keyPatents": [
    {
      "number": "<patent number e.g. US9073994B2>",
      "title": "<title>",
      "url": "<google patents URL>",
      "type": "compound" | "formulation" | "method-of-use" | "process" | "other",
      "filingYear": <integer or null>,
      "baseExpiry": <filing year + 20, RAW, no PTE — or null>,
      "estimatedExpiry": <only a DOCUMENTED granted term adjustment, else null>,
      "coversValuedIndication": <true | false | null — does this patent cover the indication being valued?>,
      "scopeRationale": "<one sentence: what indication(s) the claims actually cover>",
      "pProtective": <0-1, likelihood this patent actually blocks generic entry, or null>,
      "pProtectiveLow": <0-1, your 15th-percentile bound (state BEFORE the central), or null>,
      "pProtectiveHigh": <0-1, your 85th-percentile bound, or null>,
      "crossCheckOutOf10": <0-10, second framing: of 10 comparable challenged patents of this type, how many hold? or null>,
      "pProtectiveRationale": "<design-around reasoning; REQUIRED for pProtective to be used>",
      "relevance": "high" | "medium" | "low",
      "reason": "<one sentence>"
    }
  ],
  "reasoning": "<2-4 sentences plain English explaining the LOE range>",
  "caveats": ["<caveat 1>", "<caveat 2>"]
}`;

  const userMessage = `Drug: ${drugName}${sponsor ? `\nSponsor: ${sponsor}` : ""}${
    indication
      ? `\nINDICATION BEING VALUED: ${indication}\n\nJudge coversValuedIndication for every patent against THIS indication specifically.`
      : `\n(No specific indication supplied — set coversValuedIndication to null rather than guessing.)`
  }

Search for patents on patents.google.com, lens.org, and espacenet.com, then report the patent record.`;

  const text = await callClaudeWithSearch({
    anthropicKey,
    system: systemPrompt,
    userMessage,
    maxTokens: 2000,
    maxSearches: 4,
    serperQueries: [
      `${drugName} patent expiry loss of exclusivity`,
      `${drugName} compound patent site:patents.google.com`,
    ],
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  return JSON.parse(jsonMatch[0]);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drugName = String(req.query.drugName || "").trim();
  const sponsor = req.query.sponsor ? String(req.query.sponsor).trim() : undefined;
  // The valued indication lets the analyst judge per-patent SCOPE (a method-of-use patent for a different
  // indication cannot protect this one). Optional — absent, scope is emitted as null rather than guessed.
  const indication = req.query.indication ? String(req.query.indication).trim() : undefined;

  if (!drugName) return res.status(400).json({ error: "Drug name required" });

  try {
    const __t0 = Date.now();
    const analysis = await analyzeWithClaude(drugName, sponsor, indication);

    // Module 2: the facilitator checker — one batched call auditing the pProtective RATIONALES
    // (never proposing numbers). Shared transport/gate/health markers (lib/elicitation-checker);
    // display-only prose returned as elicitationReview, rendered in the LOE panel.
    const pats = (analysis.keyPatents ?? []).filter((k: any) => k?.pProtective != null);
    let elicitationReview: { findings: { severity: string; message: string }[]; flags: string[] } | undefined;
    if (pats.length) {
      const digest = pats.map((k: any) =>
        `${k.number} (${k.type}${k.coversValuedIndication === false ? ", does NOT cover the valued indication" : ""}): pProtective ${k.pProtective}${k.pProtectiveLow != null ? ` (15/85 range ${k.pProtectiveLow}–${k.pProtectiveHigh ?? "?"})` : ""}${k.crossCheckOutOf10 != null ? `, cross-check "${k.crossCheckOutOf10} of 10 hold"` : ""} — rationale: ${k.pProtectiveRationale ?? "(none — the engine will discard this number)"}`
      ).join("\n");
      elicitationReview = await runElicitationChecker({
        apiKey: process.env.ANTHROPIC_API_KEY,
        handlerStartMs: __t0,
        subjectLabel: "the patent-strength elicitations",
        allowedQuantities: ["pProtective", "loeRange", "general"],
        prompt: `You are the FACILITATOR auditing a patent analyst's protective-probability elicitations for ${drugName}${indication ? ` (valued indication: ${indication})` : ""}. Audit each RATIONALE — never propose a replacement number; any number you mention must be copied from the input.

${digest}

Overall LOE range stated: ${analysis.loeMin ?? "?"}–${analysis.loeMax ?? "?"} (best ${analysis.bestEstimate ?? "?"}). Reasoning: ${analysis.reasoning ?? "(none)"}

Report ONLY genuine issues (max 5):
1. Base-rate neglect: compound patents mostly survive challenge; method-of-use patents mostly get carved out (§viii) — a value fighting those base rates needs case-specific evidence, not vibes.
2. Anchoring: pProtective suspiciously equal to a round default or another patent's value.
3. Availability: rationale leaning on one famous case (e.g. GSK v. Teva alone) rather than the litigation record for this patent type.
4. Rationale↔number arithmetic: a cross-check tally of "N of 10 hold" must roughly imply the stated probability; a rationale full of hedges must not carry a confident number.
5. Scope coherence: a patent said NOT to cover the valued indication cannot be the reason for a late LOE; ranges too narrow given admitted uncertainty.

Respond with STRICT JSON only:
{"findings":[{"quantity":"pProtective|loeRange|general","severity":"high|medium|info","message":"one or two sentences, name the patent number"}]}
Empty findings array if everything is defensible.`,
      });
    }

    return res.status(200).json({ found: analysis.keyPatents?.length || 0, ...analysis, ...(elicitationReview ? { elicitationReview } : {}) });
  } catch (e: any) {
    return res.status(200).json({
      found: 0, loeMin: null, loeMax: null, bestEstimate: null,
      confidence: "low", keyPatents: [],
      reasoning: `Patent analysis failed: ${e?.message}`,
      caveats: [],
    });
  }
}
