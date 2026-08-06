import type { NextApiRequest, NextApiResponse } from "next";
import { runLoePipeline } from "../../../lib/loeFullPipeline";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drugName = String(req.query.drugName || "").trim();
  const sponsor = req.query.sponsor ? String(req.query.sponsor).trim() : undefined;
  // The indication being valued, so per-patent SCOPE is judged against it (a method-of-use patent claiming a
  // different indication cannot protect this one). Optional — absent, scope comes back null and every patent
  // is treated as covering, with the patent-type probability carrying the risk.
  const indication = req.query.indication ? String(req.query.indication).trim() : undefined;
  if (!drugName) return res.status(400).json({ error: "Drug name required" });

  try {
    const result = await runLoePipeline(drugName, sponsor, indication ? { indication } : undefined);
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "LOE pipeline failed" });
  }
}
