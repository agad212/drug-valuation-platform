/**
 * Server-side access gate shared by middleware (edge) and /api/gate (node).
 * The code never ships to the browser: comparison happens server-side and the
 * cookie holds a SHA-256 token derived from the code, not the code itself.
 * Override the code without a deploy by setting SITE_ACCESS_CODE in Vercel env.
 */

export const GATE_COOKIE = "dv_gate";
// 400 days — the maximum lifetime browsers allow; middleware renews it on every
// visit, so one unlock effectively lasts as long as the browser is used.
export const GATE_MAX_AGE = 400 * 24 * 60 * 60;

export function gateCode(): string {
  return process.env.SITE_ACCESS_CODE || "5252";
}

export async function gateToken(): Promise<string> {
  const data = new TextEncoder().encode(`dv-gate-v1|${gateCode()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
