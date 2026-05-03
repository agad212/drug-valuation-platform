import type { NextApiRequest, NextApiResponse } from "next";
import { getShare, upsertValuation } from "../../../../lib/store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const slug = String(req.query.slug || "");
  if (req.method === "GET") {
    const v = await getShare(slug);
    if (!v) return res.status(404).json({ error: "Not found" });
    return res.status(200).json(v);
  }
  if (req.method === "POST") {
    const body = req.body || {};
    const v = await upsertValuation({ ...body, slug });
    return res.status(200).json(v);
  }
  return res.status(405).json({ error: "Method not allowed" });
}
