import { linkSync, mkdirSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { chapterFilename } from "./remap.js";

/**
 * Moves any chapter still living in the legacy per-source tree into the canonical
 * one, so a series occupies exactly one place. Hardlinks, so the legacy tree is
 * untouched and this is reversible until you delete it.
 */
export async function relayout(opts: { seriesId?: number; dryRun?: boolean } = {}): Promise<void> {
  const p = db();
  const rows = (await p.query<{ series_id: number; title: string; folder: string; chapter_number: string; file_path: string; scanlator: string | null }>(
    `SELECT c.series_id, s.title, s.folder, c.chapter_number, c.file_path, c.scanlator
       FROM chapter c JOIN series s ON s.id = c.series_id
      WHERE c.file_path NOT LIKE $1 ${opts.seriesId ? "AND c.series_id = $2" : ""}
      ORDER BY c.series_id, c.chapter_number`,
    opts.seriesId ? [`${config.libraryRoot}/%`, opts.seriesId] : [`${config.libraryRoot}/%`])).rows;

  if (rows.length === 0) { console.log("every chapter already lives in the canonical tree"); return; }

  let moved = 0, gone = 0;
  const touched = new Set<number>();
  for (const r of rows) {
    if (!existsSync(r.file_path)) { gone++; continue; }
    const dest = `${config.libraryRoot}/${r.folder}/${chapterFilename(r.title, r.chapter_number, r.scanlator)}`;
    if (opts.dryRun) { moved++; touched.add(r.series_id); continue; }
    mkdirSync(`${config.libraryRoot}/${r.folder}`, { recursive: true });
    if (!existsSync(dest)) linkSync(r.file_path, dest);
    await p.query("UPDATE chapter SET file_path = $1 WHERE series_id = $2 AND chapter_number = $3",
      [dest, r.series_id, r.chapter_number]);
    moved++; touched.add(r.series_id);
  }
  console.log(`${opts.dryRun ? "[dry run] " : ""}relocated ${moved} chapters across ${touched.size} series`);
  if (gone > 0) console.log(`  ${gone} ledger rows point at files that are no longer on disk`);
}
