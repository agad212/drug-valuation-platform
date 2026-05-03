import type { NextApiRequest, NextApiResponse } from "next";
import { inferLOE } from "../../../lib/loeAdapter";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const drugName = String(req.query.drugName || "");
  const out = await inferLOE(drugName);
  res.status(200).json({ loeDate: out.loeDate, loeReason: out.reasons, sources: out.sources });
}
