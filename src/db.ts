import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// A DATE column has no time and no zone. Left to its default, pg parses it into a
// JS Date at local midnight, which shifts the day across a timezone boundary and
// stringifies without a year. Keep it as the "YYYY-MM-DD" the database sent.
pg.types.setTypeParser(1082, (v: string) => v);
import { config } from "./config.js";
import type { Stranded } from "./match.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "db");

let pool: pg.Pool | undefined;
export const db = (): pg.Pool => {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not set");
  pool ??= new pg.Pool({ connectionString: config.databaseUrl });
  return pool;
};
export const closeDb = async (): Promise<void> => { await pool?.end(); pool = undefined; };

/** Applies db/*.sql in filename order, once each. Safe to re-run. */
export async function migrate(): Promise<void> {
  const p = db();
  await p.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(
    (await p.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename),
  );
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) { console.log(`  skip ${f}`); continue; }
    const sql = await readFile(join(migrationsDir, f), "utf8");
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`  applied ${f}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Stages the importer's findings for confirmation. Identity is confirmed once by a
 * human and then never re-derived, so this table is a queue, not a cache: re-running
 * the importer replaces unconfirmed rows and leaves confirmed ones alone.
 */
export async function stageCandidates(resolved: Stranded[], review: Stranded[]): Promise<number> {
  const p = db();
  const client = await p.connect();
  let written = 0;
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM import_candidate WHERE confirmed_series_id IS NULL");
    for (const s of [...resolved, ...review]) {
      await client.query(
        `INSERT INTO import_candidate
           (folder, dead_source, file_count, suwayomi_manga_id, resolved_title, match_kind, candidates)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [s.folder, s.deadSource, s.files, s.suwayomiMangaId, s.exactTitleKnown ? s.title : null,
         s.candidates.length > 0 ? "exact" : "review", JSON.stringify(s.candidates)],
      );
      written++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return written;
}
