import type { NextApiRequest, NextApiResponse } from "next";
import { GATE_COOKIE, GATE_MAX_AGE, gateCode, gateToken } from "../../lib/gate";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const code = String(req.body?.code ?? "").trim();
  if (!code || code !== gateCode()) {
    return res.status(401).json({ error: "Wrong code — try again." });
  }

  const token = await gateToken();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${GATE_COOKIE}=${token}; Max-Age=${GATE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
  return res.status(200).json({ ok: true });
}
