import type { NextApiRequest, NextApiResponse } from "next";
import { checkAdminKey, listSurveyResponses } from "../../../lib/survey-store";
import { SURVEY_QUESTIONS } from "../../../lib/survey-questions";

export const config = { maxDuration: 300 };

const SYSTEM_PROMPT = `You are a customer-discovery analyst working for a solo founder. The founder interviewed biopharma R&D / portfolio / BD professionals about how strategic R&D decisions with value implications actually get made, and about concept fit for a product idea: an AI platform that builds defensible, sourced asset valuations (preclinical to LCM) with traceable reasoning and lets users compare strategic options (indication sequencing, trial design, partnering, go/no-go) via plain-language prompts.

You will receive the raw survey responses. Produce a rigorous synthesis in GitHub-flavored markdown with these sections:

## Executive summary
3-6 bullets: the strongest signals, stated plainly. Note the sample size and how much weight it can bear.

## How these decisions happen today
Decision types seen; tools/analyses/people teams actually lean on; where the process is slowest or most contested; how well analyses survive challenge; analyses teams wanted but couldn't produce; whether this is recurring or one-off work.

## Concept fit
Would-use signal (count leans yes / maybe / no and be skeptical of politeness); where it would plug into their process; stated objections or reasons to not bother; what it must prove to be trusted in leadership-facing decisions; build-internally vs outsource lean; every price anchor mentioned, verbatim.

## People map
Roles said to feel this pain most; any named or implied referrals worth chasing.

## Verbatim worth keeping
Up to 8 short quotes that carry signal, each attributed as [R1], [R2], ... with role if given.

## Per-respondent snapshot
A markdown table: respondent, role/org (if given), decision discussed, sharpest pain, concept-fit lean, price anchor, referral.

## Cautions and contradictions
Where answers conflict, where enthusiasm looks polite rather than real (e.g., no budget owner, vague plug-in point), and what is still unknown.

## Recommended next moves
3-5 concrete actions for the founder.

Rules: use ONLY the provided responses — never invent respondents, quotes, or numbers. If a section has no data, say so in one line. With a small sample, say "n=X" rather than percentages.`;

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

  const labelById = new Map(SURVEY_QUESTIONS.map((q) => [q.id, q.short]));
  const transcript = responses
    .map((r, i) => {
      const lines = Object.entries(r.answers)
        .map(([qid, val]) => `${labelById.get(qid) || qid}: ${val}`)
        .join("\n");
      return `### [R${i + 1}] — submitted ${r.createdAt.slice(0, 10)}\n${lines}`;
    })
    .join("\n\n");

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
        max_tokens: 6000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here are all ${responses.length} survey responses:\n\n${transcript}\n\nProduce the synthesis.`,
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
