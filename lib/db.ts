/**
 * Database wrapper — uses Neon Postgres if DATABASE_URL is set, otherwise null.
 * All functions in store.ts fall back to in-memory when this returns null.
 */

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { neon } = require("@neondatabase/serverless");
    return neon(url);
  } catch {
    return null;
  }
}

export async function ensureTable() {
  const sql = getDb();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS valuations (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}
