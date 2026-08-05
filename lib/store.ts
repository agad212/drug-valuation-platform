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

// ─── Diagnostics ──────────────────────────────────────────────────────────────
// Is DATABASE_URL present + non-empty in THIS runtime? (boolean only — never logs the URL/secret.) The
// Neon env var only reaches a function that was deployed AFTER it was added and is scoped to that env, so
// this makes "is Neon actually live here?" observable in the deployed function logs instead of a guess.
function hasDbUrl(): boolean {
  return !!process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0;
}
// One structured, grep-able line per store call: DATABASE_URL-is-live + which path (neon vs in-memory Map)
// the call actually took. `databaseUrlLive:true` with `path:"memory"` means the env var is set but the
// Neon client failed to init (getDb caught + returned null) — a distinct, useful signal.
function logStore(op: string, extra?: Record<string, unknown>) {
  try { console.log(JSON.stringify({ tag: "store-diagnostic", op, databaseUrlLive: hasDbUrl(), ...extra })); } catch { /* logging must never throw */ }
}

// ─── Exported async functions ─────────────────────────────────────────────────

export async function upsertValuation(v: Valuation): Promise<Valuation> {
  const id = v.id || cryptoId();
  const slug = v.slug || id;
  const now = new Date().toISOString();
  const next: Valuation = { ...v, id, slug, createdAt: v.createdAt || now, updatedAt: now };

  const sql = getDb();
  logStore("upsert", { id, slug, path: sql ? "neon" : "memory" });
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
      // A failed Neon write is a DURABILITY failure — the record would only survive in the ephemeral Map
      // below and 404 on read from another instance / after a cold start. Make it LOUD (it was previously
      // swallowed into the silent fallback, so a broken persist looked like success).
      console.error(JSON.stringify({ tag: "store-write-FAILED", id, slug, databaseUrlLive: hasDbUrl(), error: String((e as any)?.message ?? e) }));
    }
  }

  // In-memory fallback (demo mode with no DATABASE_URL — or, with the error logged above, a failed Neon write)
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
  logStore("getShare", { slug, path: sql ? "neon" : "memory" });
  if (sql) {
    try {
      await ensureTable();
      const rows = await sql`SELECT id, slug, name, data FROM valuations WHERE slug = ${slug} LIMIT 1`;
      if (rows.length === 0) return null;
      const r = rows[0];
      return { ...r.data, id: r.id, slug: r.slug, name: r.name } as Valuation;
    } catch (e) {
      console.error(JSON.stringify({ tag: "store-share-read-FAILED", slug, databaseUrlLive: hasDbUrl(), error: String((e as any)?.message ?? e) }));
    }
  }
  return bySlug.get(slug) ?? null;
}
