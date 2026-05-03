import type { NextApiRequest, NextApiResponse } from "next";
import { fetchCtgov } from "../../../lib/ctgov";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const nctId = String(req.query.nctId || "");
  const trial = await fetchCtgov(nctId);
  if (!trial) return res.status(404).json({ error: "Not found" });
  return res.status(200).json(trial);
}
