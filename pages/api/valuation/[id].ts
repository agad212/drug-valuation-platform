import type { NextApiRequest, NextApiResponse } from "next";
import { getValuation } from "../../../lib/store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");
  const v = await getValuation(id);
  if (!v) return res.status(404).json({ error: "Not found" });
  res.status(200).json(v);
}
