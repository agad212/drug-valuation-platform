import type { NextApiRequest, NextApiResponse } from "next";
import { runLoePipeline } from "../../../lib/loeFullPipeline";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drugName = String(req.query.drugName || "").trim();
  const sponsor = req.query.sponsor ? String(req.query.sponsor).trim() : undefined;
  if (!drugName) return res.status(400).json({ error: "Drug name required" });

  try {
    const result = await runLoePipeline(drugName, sponsor);
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "LOE pipeline failed" });
  }
}
