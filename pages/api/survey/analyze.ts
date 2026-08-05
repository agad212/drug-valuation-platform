import type { NextApiRequest, NextApiResponse } from "next";
import { checkAdminKey, listSurveyResponses } from "../../../lib/survey-store";
import { SEGMENTS, QUESTIONS_BY_SEGMENT, type SurveyQuestion } from "../../../lib/survey-questions";

export const config = { maxDuration: 300 };

const SYSTEM_PROMPT = `You are a customer-discovery analyst working for a solo founder. The founder is surveying five audiences about how high-stakes biopharma asset decisions actually get made, and about concept fit for products under development:

1. Biopharma R&D decision makers — shown the STRATEGIC ADVISOR concept: an AI platform using financial value and ROI metrics to compare R&D development strategies at asset AND portfolio level. Defensible sourced valuations (preclinical to LCM) with traceable reasoning; compares options from broad (indication sequencing, asset prioritization, go/no-go) down to trial-design detail (endpoint, comparator, adaptive design, sample size, I/E criteria, alpha and futility choices); can also generate optimal strategies. Plain-language prompts.
2. Biopharma M&A / BD leaders — shown the VALUATION-ONLY concept: defensible, sourced, probability-adjusted valuations of any asset or company, traceable to sources, instantly re-runnable as deal terms or data change. No strategic-options advisor.
3. VC / Private equity investors — shown the STRATEGIC ADVISOR concept, framed around deal diligence and follow-on scenarios.
4. Hedge fund / public equities investors — shown the VALUATION-ONLY concept, framed around positions and catalysts.
5. University tech transfer offices — shown the STRATEGIC ADVISOR concept, framed around licensing, spinouts, and development-path strategy.

The survey is deliberately confidentiality-safe: mostly 5-point scales (reported as "n/5" with anchor meanings) and multi-select category picks, plus respondent function/organization/seniority. There is one optional free-text field. Respondent tags: [B#] biopharma R&D, [M#] M&A/BD, [V#] VC/PE, [H#] hedge fund, [T#] tech transfer.

Produce a rigorous synthesis in GitHub-flavored markdown:

## Executive summary
3-6 bullets: the strongest signals across all audiences, stated plainly. Note per-segment sample sizes and how much weight they can bear.

Then ONE SECTION PER SEGMENT THAT HAS RESPONSES (skip empty segments with a single line "No responses yet."):

## Biopharma R&D decision makers (n=X)
## Biopharma M&A / BD leaders (n=X)
## VC / PE investors (n=X)
## Hedge funds / public equities (n=X)
## University tech transfer offices (n=X)

Within each segment section cover, with subheadings:
- **Pain intensity** — read the Part 1 scales together: decision frequency, turnaround time, whether analyses hold up when challenged, re-run speed, sourcing quality, skipped analyses (which ones), and whether assumption disagreement drives delay. Report scale answers as means or counts (e.g., "re-run within a day: mean 1.8/5 across n=4"). Flag the sharpest pains (low robustness + high frequency = strongest signal).
- **Concept fit** — would-use scores (report distribution, be skeptical of politeness), where it plugs in (count each option), trust requirements (count each), build-vs-buy lean, and every price-range answer (report the modal range and spread).
- **Who feels the pain** — tally the roles selected.
- **Seniority mix** — levels and functions represented; note if the sample skews junior or senior.

## Cross-segment synthesis
Where the audiences agree or diverge on pain and willingness to pay; which segment shows the strongest pull (high pain × high would-use × credible price anchors); implications for which product to lead with.

## Notable free-text comments
Quote any open-field comments worth keeping, attributed by tag. If none, one line.

## Per-respondent snapshot
One markdown table across all segments: tag, segment, function, level, org type, would-use (n/5), price range, sharpest pain signal.

## Cautions
Small-n warnings, acquiescence bias on agree scales, segments where enthusiasm looks polite (high would-use but low price anchor or "nothing would get it there" on trust), and what is still unknown.

## Recommended next moves
3-5 concrete actions for the founder.

Rules: use ONLY the provided responses — never invent respondents, quotes, or numbers. With small samples report counts ("3 of 4"), not percentages.`;

function formatAnswer(q: SurveyQuestion | undefined, val: string): string {
  if (!q) return val;
  if (q.kind === "scale") {
    const n = Number(val);
    if (q.stepLabels) return `${val}/5 (${q.stepLabels[n - 1] || "?"})`;
    if (q.anchors) return `${val}/5 [1=${q.anchors.min}, 5=${q.anchors.max}]`;
    return `${val}/5`;
  }
  return val;
}

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
    const byId = new Map(QUESTIONS_BY_SEGMENT[seg.id].map((q) => [q.id, q]));
    const blocks = segResponses.map((r, idx) => {
      const tag = `${seg.tagPrefix}${segResponses.length - idx}`;
      const lines = Object.entries(r.answers)
        .map(([qid, val]) => {
          const q = byId.get(qid);
          return `${q?.short || qid}: ${formatAnswer(q, val)}`;
        })
        .join("\n");
      return `### [${tag}] — submitted ${r.createdAt.slice(0, 10)}\n${lines}`;
    });
    sections.push(
      `## SEGMENT: ${seg.label} (${seg.product} concept) — ${segResponses.length} response(s)\n\n${blocks.join("\n\n")}`
    );
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
