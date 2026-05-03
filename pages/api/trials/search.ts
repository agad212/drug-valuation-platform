import type { NextApiRequest, NextApiResponse } from "next";
import { searchTrialsByDrug, type CtgovTrial } from "../../../lib/ctgov";

async function rankWithClaude(
  drugName: string,
  currentPhase: string,
  trials: CtgovTrial[]
): Promise<{ ranked: CtgovTrial[]; summary: string; recommendedNctId: string }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey || trials.length === 0) return { ranked: trials.slice(0, 8), summary: "", recommendedNctId: trials[0]?.nctId ?? "" };

  // Send up to 40 trials to Claude — enough context without blowing token budget
  const candidates = trials.slice(0, 40);
  const trialList = candidates.map((t, i) =>
    `[${i + 1}] ${t.nctId} | ${t.phaseRaw || t.phase || "?"} | ${t.statusLabel} | ${t.sponsor || "?"} | ${t.conditions?.[0] || "?"} | ${t.title?.slice(0, 100) || "?"}`
  ).join("\n");

  const isApproved = currentPhase === "Approved";

  const prompt = `You are a pharmaceutical clinical trial analyst.

Drug: ${drugName}
Current development stage: ${currentPhase}
${isApproved ? "This drug is already approved. Focus on pivotal approval trials and key new indication studies." : "This is a pipeline drug. Focus on the trials most likely to support approval — prioritize Phase 3, then Phase 2 pivotal studies."}

Trial list (index | NCT ID | phase | status | sponsor | primary condition | title):
${trialList}

Select the 5-8 most relevant trials for a drug valuation analyst. Prioritize:
1. Pivotal/registration trials (Phase 3 completed or active)
2. Key Phase 2 trials in major indications
3. For approved drugs: label-expansion studies

Respond ONLY with valid JSON — no markdown, no extra text:
{
  "selectedIndices": [1, 3, 7, ...],
  "recommendedIndex": 2,
  "reasons": {
    "NCT...": "one sentence — why this trial matters for valuation",
    ...
  },
  "summary": "2-3 sentences on the overall clinical trial landscape for ${drugName}"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return { ranked: trials.slice(0, 8), summary: "", recommendedNctId: trials[0]?.nctId ?? "" };

    const data = await res.json();
    const text: string = data?.content?.[0]?.text || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ranked: trials.slice(0, 8), summary: "", recommendedNctId: trials[0]?.nctId ?? "" };

    const parsed = JSON.parse(jsonMatch[0]);
    const indices: number[] = (parsed.selectedIndices || []).map((i: number) => i - 1);
    const recommendedIdx: number = (parsed.recommendedIndex ?? 0) - 1;
    const reasons: Record<string, string> = parsed.reasons || {};
    const summary: string = parsed.summary || "";

    const selected = indices
      .filter((i) => i >= 0 && i < candidates.length)
      .map((i) => ({ ...candidates[i], claudeReason: reasons[candidates[i].nctId] || "" }));

    const recommendedNctId = (recommendedIdx >= 0 && recommendedIdx < candidates.length)
      ? candidates[recommendedIdx].nctId : (selected[0]?.nctId ?? "");

    const selectedIds = new Set(selected.map((t) => t.nctId));
    const remainder = trials.slice(0, 8).filter((t) => !selectedIds.has(t.nctId));

    return { ranked: [...selected, ...remainder].slice(0, 8), summary, recommendedNctId };
  } catch {
    return { ranked: trials.slice(0, 8), summary: "", recommendedNctId: trials[0]?.nctId ?? "" };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drug = String(req.query.drug || "").trim();
  const currentPhase = String(req.query.phase || "Phase 2").trim();
  if (!drug) return res.status(400).json({ error: "drug parameter required" });

  try {
    const isApproved = currentPhase === "Approved";
    const trials = await searchTrialsByDrug(drug, { isApproved });

    if (trials.length === 0) {
      return res.status(200).json({ trials: [], summary: "", totalBeforeFilter: 0 });
    }

    const { ranked, summary, recommendedNctId } = await rankWithClaude(drug, currentPhase, trials);
    return res.status(200).json({ trials: ranked, summary, recommendedNctId, totalBeforeFilter: trials.length });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Search failed" });
  }
}
