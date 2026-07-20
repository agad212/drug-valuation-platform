import type { NextApiRequest, NextApiResponse } from "next";
import { checkAdminKey, listSurveyResponses } from "../../../lib/survey-store";
import { SEGMENTS, QUESTIONS_BY_SEGMENT } from "../../../lib/survey-questions";

export const config = { maxDuration: 300 };

const SYSTEM_PROMPT = `You are a customer-discovery analyst working for a solo founder. The founder is interviewing four audiences about how high-stakes biopharma decisions actually get made, and about concept fit for products under development:

1. Biopharma R&D decision makers — shown the STRATEGIC ADVISOR concept: an AI platform that builds defensible, sourced asset valuations (preclinical to LCM) with traceable reasoning and compares strategic options (indication sequencing, trial design, partnering, go/no-go) via plain-language prompts.
2. Biopharma M&A / BD professionals — shown the VALUATION-ONLY concept: defensible, sourced, probability-adjusted valuations of any asset or company, traceable to sources, instantly re-runnable as deal terms or data change. No strategic-options advisor.
3. VC / Private equity investors — shown the STRATEGIC ADVISOR concept, framed around deal diligence and follow-on scenarios.
4. Hedge fund / public equities investors — shown the VALUATION-ONLY concept, framed around positions and catalysts.

You will receive the raw survey responses, grouped by audience segment, with respondent tags like [B1] (biopharma R&D), [M1] (biopharma M&A/BD), [V1] (VC/PE), [H1] (hedge fund). Produce a rigorous synthesis in GitHub-flavored markdown:

## Executive summary
3-6 bullets: the strongest signals across all audiences, stated plainly. Note per-segment sample sizes and how much weight they can bear.

Then ONE SECTION PER SEGMENT THAT HAS RESPONSES (skip empty segments with a single line "No responses yet."):

## Biopharma R&D decision makers (n=X)
## Biopharma M&A / BD (n=X)
## VC / PE investors (n=X)
## Hedge funds / public equities (n=X)

Within each segment section cover, with subheadings:
- **How these decisions happen today** — decision types seen; tools/analyses/people actually used; slowest or most contested steps; how analyses survive challenge; analyses wanted but not produced; recurring vs one-off.
- **Concept fit** — would-use signal (count leans yes / maybe / no; be skeptical of politeness); where it would plug in; stated objections; what it must prove to be trusted; build-internally vs buy lean; every price anchor mentioned, verbatim.
- **People map** — roles said to feel this pain most; named or implied referrals worth chasing.

## Cross-segment synthesis
Where the audiences agree or diverge; which segment shows the strongest pull and why; implications for which product to lead with.

## Verbatim worth keeping
Up to 8 short quotes that carry signal, each attributed by tag ([B1], [V2], ...) with role if given.

## Per-respondent snapshot
One markdown table across all segments: tag, segment, role/org (if given), decision discussed, sharpest pain, concept-fit lean, price anchor, referral.

## Cautions and contradictions
Where answers conflict, where enthusiasm looks polite rather than real (no budget owner, vague plug-in point), and what is still unknown.

## Recommended next moves
3-5 concrete actions for the founder.

Rules: use ONLY the provided responses — never invent respondents, quotes, or numbers. With small samples, say "n=X" rather than percentages.`;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const gate = checkAdminKey(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY is not set — cannot run analysis." });
  }

  let responses;
  try {
    responses = await listSurveyResponses();
  } catch (e: any) {
    const msg =
      e?.message === "SURVEY_STORE_NOT_CONFIGURED"
        ? "Survey storage is not configured (DATABASE_URL missing)."
        : "Could not load responses.";
    return res.status(503).json({ error: msg });
  }
  if (responses.length === 0) {
    return res.status(400).json({ error: "No responses yet — nothing to analyze." });
  }

  // Group by segment; tag numbering matches the admin view (newest first → highest number).
  const sections: string[] = [];
  for (const seg of SEGMENTS) {
    const segResponses = responses.filter((r) => r.segment === seg.id);
    if (segResponses.length === 0) continue;
    const labelById = new Map(QUESTIONS_BY_SEGMENT[seg.id].map((q) => [q.id, q.short]));
    const blocks = segResponses.map((r, idx) => {
      const tag = `${seg.tagPrefix}${segResponses.length - idx}`;
      const lines = Object.entries(r.answers)
        .map(([qid, val]) => `${labelById.get(qid) || qid}: ${val}`)
        .join("\n");
      return `### [${tag}] — submitted ${r.createdAt.slice(0, 10)}\n${lines}`;
    });
    sections.push(`## SEGMENT: ${seg.label} (${seg.product} concept) — ${segResponses.length} response(s)\n\n${blocks.join("\n\n")}`);
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here are all ${responses.length} survey responses, grouped by segment:\n\n${sections.join("\n\n---\n\n")}\n\nProduce the synthesis.`,
          },
        ],
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("analyze: Anthropic error", r.status, txt.slice(0, 500));
      return res.status(502).json({ error: `AI analysis failed (Anthropic ${r.status}).` });
    }

    const data = await r.json();
    const analysis = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    if (!analysis.trim()) {
      return res.status(502).json({ error: "AI returned an empty analysis — try again." });
    }
    return res.status(200).json({ analysis, responseCount: responses.length });
  } catch (e) {
    console.error("analyze error:", e);
    return res.status(500).json({ error: "AI analysis failed unexpectedly." });
  }
}
