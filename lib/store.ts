import type { Valuation } from "./types";
import { getDb, ensureTable } from "./db";

/**
 * Persistent store — uses Neon Postgres if DATABASE_URL is set.
 * Falls back to in-memory (demo mode) if no database configured.
 */

// ─── In-memory fallback ───────────────────────────────────────────────────────
const byId = new Map<string, Valuation>();
const bySlug = new Map<string, Valuation>();

function cryptoId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ─── Exported async functions ─────────────────────────────────────────────────

export async function upsertValuation(v: Valuation): Promise<Valuation> {
  const id = v.id || cryptoId();
  const slug = v.slug || id;
  const now = new Date().toISOString();
  const next: Valuation = { ...v, id, slug, createdAt: v.createdAt || now, updatedAt: now };

  const sql = getDb();
  if (sql) {
    try {
      await ensureTable();
      const { id: _id, slug: _slug, name, ...rest } = next;
      await sql`
        INSERT INTO valuations (id, slug, name, data, updated_at)
        VALUES (${id}, ${slug}, ${name || null}, ${JSON.stringify(rest)}, NOW())
        ON CONFLICT (id) DO UPDATE
          SET slug = EXCLUDED.slug, name = EXCLUDED.name,
              data = EXCLUDED.data, updated_at = NOW()
      `;
      return next;
    } catch (e) {
      console.error("DB upsert error:", e);
    }
  }

  // In-memory fallback
  byId.set(id, next);
  bySlug.set(slug, next);
  return next;
}

export async function getValuation(id: string): Promise<Valuation | null> {
  const sql = getDb();
  if (sql) {
    try {
      await ensureTable();
      const rows = await sql`SELECT id, slug, name, data FROM valuations WHERE id = ${id} LIMIT 1`;
      if (rows.length === 0) return null;
      const r = rows[0];
      return { ...r.data, id: r.id, slug: r.slug, name: r.name } as Valuation;
    } catch (e) {
      console.error("DB get error:", e);
    }
  }
  return byId.get(id) ?? null;
}

export async function listValuations(): Promise<Valuation[]> {
  const sql = getDb();
  if (sql) {
    try {
      await ensureTable();
      const rows = await sql`SELECT id, slug, name, data FROM valuations ORDER BY updated_at DESC LIMIT 100`;
      return rows.map((r: any) => ({ ...r.data, id: r.id, slug: r.slug, name: r.name }));
    } catch (e) {
      console.error("DB list error:", e);
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function getShare(slug: string): Promise<Valuation | null> {
  const sql = getDb();
  if (sql) {
    try {
      await ensureTable();
      const rows = await sql`SELECT id, slug, name, data FROM valuations WHERE slug = ${slug} LIMIT 1`;
      if (rows.length === 0) return null;
      const r = rows[0];
      return { ...r.data, id: r.id, slug: r.slug, name: r.name } as Valuation;
    } catch (e) {
      console.error("DB share get error:", e);
    }
  }
  return bySlug.get(slug) ?? null;
}
