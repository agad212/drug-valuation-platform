// ─── Decision Analysis — AI Insight Endpoint ──────────────────────────────────
//
// POST /api/decision-analysis
// Accepts a set of computed option results and returns a 2-3 sentence
// strategic insight comparing the options.
//
// Uses Claude Haiku (no web search needed — all data is in the request).
// Fast + cheap: structured analysis, not research.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { NextApiRequest, NextApiResponse } from "next";

const MODEL = "claude-haiku-4-5-20251001";

type OptionSummary = {
  name: string;
  eNPVM: number;
  eROI: number | null;
  marginalEROI: number | null;
  ptrs: number;
  peakSalesM: number;
  devCostM: number;
  keyDrivers: string[];
  isVOI?: boolean;
  voiENPVM?: number;
};

type RequestBody = {
  drug?: string;
  phase?: string;
  options: OptionSummary[];
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { drug, phase, options } = req.body as RequestBody;

  if (!options || options.length < 2) {
    return res.status(400).json({ error: "Need at least 2 options to compare" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  // Build a compact options summary for the prompt
  const optionsSummary = options.map((o, i) => {
    const label = ["A", "B", "C", "D"][i] ?? String(i + 1);
    const lines = [
      `Option ${label}: "${o.name}"`,
      `  eNPV: $${o.eNPVM.toFixed(0)}M | eROI: ${o.eROI != null ? o.eROI.toFixed(2) + "x" : "n/a"} | PTRS: ${(o.ptrs * 100).toFixed(1)}%`,
      `  Peak Sales: $${o.peakSalesM.toFixed(0)}M | Dev Cost: $${o.devCostM.toFixed(0)}M`,
    ];
    if (i > 0 && o.marginalEROI != null) {
      lines.push(`  Marginal eROI vs A: ${o.marginalEROI.toFixed(2)}x`);
    }
    if (o.isVOI && o.voiENPVM != null) {
      lines.push(`  VOI path eNPV: $${o.voiENPVM.toFixed(0)}M`);
    }
    if (o.keyDrivers.length) {
      lines.push(`  Key drivers: ${o.keyDrivers.join("; ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");

  const prompt = `You are a pharma business development analyst. A clinical development team is comparing ${options.length} strategic options for ${drug || "a drug asset"}${phase ? ` (${phase})` : ""}.

Here is the quantitative comparison:

${optionsSummary}

Write a 2–3 sentence strategic insight for the decision team. Focus on:
1. Which option has the best risk-adjusted return and why.
2. The key tradeoff being made (e.g. higher expected value vs. capital efficiency, or certainty vs. upside).
3. One specific condition or assumption that would change the recommendation.

Be direct and specific — use the numbers. Do not hedge everything. Assume the audience understands eNPV and PTRS.`;

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
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("[decision-analysis] Claude error:", errText);
      return res.status(502).json({ error: "Claude API error", detail: errText.slice(0, 200) });
    }

    const data = await apiRes.json();
    const insight = data.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ")
      .trim() ?? "";

    return res.status(200).json({ insight });

  } catch (e: any) {
    console.error("[decision-analysis] Failed:", e?.message);
    return res.status(500).json({ error: e?.message ?? "Unknown error" });
  }
}
