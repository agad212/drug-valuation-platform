import type { NextApiRequest, NextApiResponse } from "next";
import { insertSurveyResponse } from "../../../lib/survey-store";
import { isSegmentId, questionIds } from "../../../lib/survey-questions";

const MAX_ANSWER_CHARS = 8000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const segment = req.body?.segment;
  if (!isSegmentId(segment)) {
    return res.status(400).json({ error: "Please select which best describes you first." });
  }

  const raw = req.body?.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return res.status(400).json({ error: "Missing answers." });
  }

  // Keep only this segment's question ids with non-empty string values, capped in length.
  const answers: Record<string, string> = {};
  for (const id of questionIds(segment)) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === "string" && v.trim()) {
      answers[id] = v.trim().slice(0, MAX_ANSWER_CHARS);
    }
  }
  if (Object.keys(answers).length === 0) {
    return res.status(400).json({ error: "Please answer at least one question before submitting." });
  }

  try {
    const saved = await insertSurveyResponse(segment, answers);
    return res.status(200).json({ ok: true, id: saved.id });
  } catch (e: any) {
    if (e?.message === "SURVEY_STORE_NOT_CONFIGURED") {
      return res.status(503).json({
        error: "Survey storage is not configured yet (DATABASE_URL missing). Your answers were NOT saved — please try again later.",
      });
    }
    console.error("survey submit error:", e);
    return res.status(500).json({ error: "Could not save your answers. Please try again." });
  }
}
