import { existsSync } from "node:fs";
import { db } from "./db.js";

/**
 * Drops ledger rows whose file is gone.
 *
 * The ledger means "this file is here"; a row pointing at nothing is a lie that makes
 * the library look more complete than it is and hides a chapter that should be
 * re-fetched. Rows written by earlier buggy runs survive re-seeding because seed uses
 * ON CONFLICT DO NOTHING, so this has to be an explicit operation.
 */
export async function prune(opts: { dryRun?: boolean } = {}): Promise<void> {
  const p = db();
  const rows = (await p.query<{ series_id: number; chapter_number: string; file_path: string; title: string }>(
    "SELECT c.series_id, c.chapter_number, c.file_path, s.title FROM chapter c JOIN series s ON s.id = c.series_id")).rows;
  const gone = rows.filter((r) => !existsSync(r.file_path));

  if (gone.length === 0) { console.log(`ledger is clean: all ${rows.length} rows resolve to a file`); return; }

  const perSeries = new Map<string, number>();
  for (const g of gone) perSeries.set(g.title, (perSeries.get(g.title) ?? 0) + 1);
  console.log(`${opts.dryRun ? "[dry run] " : ""}${gone.length} of ${rows.length} ledger rows point at a missing file:`);
  for (const [title, n] of [...perSeries].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}  ${title.slice(0, 60)}`);
  }
  if (opts.dryRun) return;

  for (const g of gone) {
    await p.query("DELETE FROM chapter WHERE series_id = $1 AND chapter_number = $2",
      [g.series_id, g.chapter_number]);
  }
  console.log(`removed ${gone.length}; those chapters will resurface as gaps, which is the truth`);
}
