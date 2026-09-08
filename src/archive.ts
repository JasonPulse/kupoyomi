import { linkSync, mkdirSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { heldChapters } from "./held.js";
import { canonical } from "./seed.js";
import { adoptFile } from "./remap.js";

/**
 * Files a finished series: adopts everything on disk into the canonical tree, gives it
 * no source binding, and takes it out of the review queue for good.
 *
 * A completed series has no useful migration target. The point of a binding is to
 * receive new chapters, and there will not be any. Previously this state was
 * unrepresentable, so a series you had finished reading kept offering migrations that
 * would only ever lose you chapters.
 */
export async function archiveCandidate(candidateId: number, opts: { dryRun?: boolean } = {}): Promise<void> {
  const p = db();
  const cand = (await p.query<{ id: number; folder: string; dead_source: string | null; resolved_title: string | null; suwayomi_manga_id: number | null }>(
    "SELECT id, folder, dead_source, resolved_title, suwayomi_manga_id FROM import_candidate WHERE id = $1",
    [candidateId])).rows[0];
  if (!cand) throw new Error(`no candidate ${candidateId}`);

  const title = cand.resolved_title ?? cand.folder;
  const held = await heldChapters(cand.dead_source ?? "", cand.folder, cand.suwayomi_manga_id);
  if (held.size === 0) throw new Error(`candidate ${candidateId} has no readable files to archive`);

  const folder = canonical(title);
  const targetDir = `${config.libraryRoot}/${folder}`;
  if (opts.dryRun) {
    console.log(`[dry run] archive "${title}": ${held.size} chapters -> ${targetDir}, no source binding`);
    return;
  }

  const client = await p.connect();
  let adopted = 0;
  try {
    await client.query("BEGIN");
    const s = await client.query<{ id: number }>(
      `INSERT INTO series (title, folder, status, muted) VALUES ($1,$2,'COMPLETED',true)
       ON CONFLICT (folder) DO UPDATE SET status = 'COMPLETED', muted = true RETURNING id`,
      [title, folder]);
    const seriesId = s.rows[0]!.id;

    for (const [num, h] of [...held.entries()].sort((a, b) => a[0] - b[0])) {
      const src = `${config.legacyRoot}/${cand.dead_source}/${cand.folder}/${h.file}`;
      if (!existsSync(src)) continue;
      if (await adoptFile(seriesId, title, folder, {
        number: String(num), src, scanlator: h.scanlator,
        pageCount: h.pageCount, uploadedAt: h.uploadedAt,
      })) adopted++;
    }
    await client.query(
      "UPDATE import_candidate SET confirmed_series_id = $1, resolution = 'archived' WHERE id = $2",
      [seriesId, candidateId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  console.log(`archived "${title}" as complete: ${adopted} chapters adopted, no source binding`);
  console.log(`  it will never be searched, migrated or stall-alerted again`);
}
