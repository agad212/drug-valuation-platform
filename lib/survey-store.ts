import type { NextApiRequest } from "next";
import { getDb } from "./db";

/**
 * Survey response store — Neon Postgres when DATABASE_URL is set.
 * In-memory fallback is allowed ONLY off-Vercel (local dev); on Vercel a missing
 * database is a hard error so responses are never silently lost between lambdas.
 */

export type SurveyResponse = {
  id: string;
  createdAt: string;
  answers: Record<string, string>;
};

const memory: SurveyResponse[] = [];

function cryptoId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function hasDurableStore(): boolean {
  return !!getDb();
}

async function ensureSurveyTable() {
  const sql = getDb();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS survey_responses (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export async function insertSurveyResponse(answers: Record<string, string>): Promise<SurveyResponse> {
  const resp: SurveyResponse = {
    id: cryptoId(),
    createdAt: new Date().toISOString(),
    answers,
  };

  const sql = getDb();
  if (sql) {
    await ensureSurveyTable();
    await sql`
      INSERT INTO survey_responses (id, data, created_at)
      VALUES (${resp.id}, ${JSON.stringify({ answers })}, ${resp.createdAt})
    `;
    return resp;
  }

  if (process.env.VERCEL) {
    throw new Error("SURVEY_STORE_NOT_CONFIGURED");
  }
  memory.push(resp);
  return resp;
}

export async function listSurveyResponses(): Promise<SurveyResponse[]> {
  const sql = getDb();
  if (sql) {
    await ensureSurveyTable();
    const rows = await sql`
      SELECT id, data, created_at FROM survey_responses ORDER BY created_at DESC LIMIT 500
    `;
    return rows.map((r: any) => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      answers: (r.data && r.data.answers) || {},
    }));
  }

  if (process.env.VERCEL) {
    throw new Error("SURVEY_STORE_NOT_CONFIGURED");
  }
  return [...memory].reverse();
}

/**
 * Admin gate for the results/analyze endpoints.
 * Key comes from the request body; compared against SURVEY_ADMIN_KEY env var.
 */
export function checkAdminKey(req: NextApiRequest): { ok: boolean; status: number; error?: string } {
  const expected = process.env.SURVEY_ADMIN_KEY;
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "SURVEY_ADMIN_KEY is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.",
    };
  }
  const provided = (req.body && req.body.adminKey) || "";
  if (typeof provided !== "string" || provided.length === 0 || provided !== expected) {
    return { ok: false, status: 401, error: "Wrong access key." };
  }
  return { ok: true, status: 200 };
}
