import type { NextApiRequest, NextApiResponse } from "next";
import { callClaudeWithSearch } from "../../../lib/claudeSearch";

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
    const analysis = await analyzeWithClaude(drugName, sponsor, indication);
    return res.status(200).json({ found: analysis.keyPatents?.length || 0, ...analysis });
  } catch (e: any) {
    return res.status(200).json({
      found: 0, loeMin: null, loeMax: null, bestEstimate: null,
      confidence: "low", keyPatents: [],
      reasoning: `Patent analysis failed: ${e?.message}`,
      caveats: [],
    });
  }
}
