import type { NextApiRequest, NextApiResponse } from "next";
import { checkAdminKey, listSurveyResponses } from "../../../lib/survey-store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const gate = checkAdminKey(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  try {
    const responses = await listSurveyResponses();
    return res.status(200).json({ responses });
  } catch (e: any) {
    if (e?.message === "SURVEY_STORE_NOT_CONFIGURED") {
      return res.status(503).json({
        error: "Survey storage is not configured (DATABASE_URL missing). Create a Neon database in Vercel → Storage, then redeploy.",
      });
    }
    console.error("survey results error:", e);
    return res.status(500).json({ error: "Could not load responses." });
  }
}
