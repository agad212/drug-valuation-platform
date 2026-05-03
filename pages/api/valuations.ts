import type { NextApiRequest, NextApiResponse } from "next";
import { listValuations, upsertValuation } from "../../lib/store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return res.status(200).json(await listValuations());
  if (req.method === "POST") return res.status(200).json(await upsertValuation(req.body || {}));
  return res.status(405).json({ error: "Method not allowed" });
}
