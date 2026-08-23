import { linkSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { scanLegacyTree } from "./disk.js";
import { parseChapterNumber } from "./chapternum.js";
import { chapterFilename } from "./remap.js";

/**
 * Adopts chapters already on disk into a series, from every folder that holds them.
 *
 * remap adopts from one folder: the single import_candidate row confirmed for the
 * series. 7th Time Loop had two, a MangaFire folder with 46 files and a hand-made
 * top-level folder with 29, and only the first was ever adopted. So chapters 1, 5.5 and
 * 21.5 sat on disk while the queue was downloading them again, which is the exact
 * complaint this project was built to answer.
 *
 * Matching a folder to a series is a judgement call, so this reports what it would take
 * and takes it only when told. Chapter numbers come from filenames, because a hand-made
 * folder was never in any snapshot.
 */
export type AdoptSource = {
  path: string; folder: string; sourceDir: string | null;
  /** Chapter number to the file that would supply it, for chapters not already held. */
  offers: Map<number, string>;
  /** How many of its files are chapters the series already holds. */
  alreadyHeld: number;
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * How much of `a` is present in `b`, as a fraction, comparing letters only. Folder names
 * lose punctuation and gain underscores on the way to disk, so an exact match is no use:
 * "7th_Time_Loop_-_The_Villainess_Enjoys..." has to match "7th Time Loop: The Villainess
 * Enjoys...". A prefix test on the normalised forms is enough and cannot match by
 * accident at these lengths.
 */
const looksLikeSame = (title: string, folder: string): boolean => {
  const a = norm(title), b = norm(folder);
  if (a.length < 8 || b.length < 8) return a === b;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.startsWith(shorter.slice(0, Math.max(12, Math.floor(shorter.length * 0.8))));
};

export async function findOnDisk(seriesId: number): Promise<{
  title: string; held: Set<number>; sources: AdoptSource[];
}> {
  const p = db();
  const s = (await p.query<{ title: string; folder: string }>(
    "SELECT title, folder FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!s) throw new Error(`no series ${seriesId}`);
  const held = new Set((await p.query<{ n: string }>(
    "SELECT chapter_number AS n FROM chapter WHERE series_id = $1", [seriesId])).rows.map((r) => Number(r.n)));

  const sources: AdoptSource[] = [];
  for (const d of await scanLegacyTree()) {
    if (!looksLikeSame(s.title, d.folder)) continue;
    const dir = d.sourceDir ? `${config.legacyRoot}/${d.sourceDir}/${d.folder}` : `${config.legacyRoot}/${d.folder}`;
    // One file per chapter number, largest wins: the ledger allows exactly one, and the
    // largest file is the complete scanlation rather than a truncated retry.
    const best = new Map<number, { file: string; size: number }>();
    let alreadyHeld = 0;
    for (const f of d.files) {
      const n = parseChapterNumber(f);
      if (n === null) continue;
      if (held.has(n)) { alreadyHeld++; continue; }
      let size = 0;
      try { size = statSync(`${dir}/${f}`).size; } catch { continue; }
      const prev = best.get(n);
      if (!prev || size > prev.size) best.set(n, { file: f, size });
    }
    sources.push({
      path: dir, folder: d.folder, sourceDir: d.sourceDir, alreadyHeld,
      offers: new Map([...best.entries()].map(([n, v]) => [n, v.file])),
    });
  }
  return { title: s.title, held, sources };
}

export async function adoptFromDisk(seriesId: number, opts: { dryRun?: boolean } = {}): Promise<number> {
  const p = db();
  const { title, held, sources } = await findOnDisk(seriesId);
  const series = (await p.query<{ folder: string }>(
    "SELECT folder FROM series WHERE id = $1", [seriesId])).rows[0]!;
  const targetDir = `${config.libraryRoot}/${series.folder}`;

  console.log(`${opts.dryRun ? "[dry run] " : ""}${title}: holds ${held.size} chapters`);
  if (sources.length === 0) { console.log("  no folder on disk looks like this series"); return 0; }

  // Claimed across folders, so two folders offering the same chapter adopt it once.
  const claimed = new Set<number>();
  let adopted = 0;
  for (const src of sources.sort((a, b) => b.offers.size - a.offers.size)) {
    const fresh = [...src.offers.entries()].filter(([n]) => !claimed.has(n)).sort((a, b) => a[0] - b[0]);
    console.log(`  ${src.path}`);
    console.log(`    ${src.alreadyHeld} already held, ${fresh.length} to adopt${
      fresh.length ? `: ${fresh.slice(0, 14).map(([n]) => n).join(", ")}${fresh.length > 14 ? " ..." : ""}` : ""}`);
    if (opts.dryRun) { fresh.forEach(([n]) => claimed.add(n)); continue; }
    for (const [n, file] of fresh) {
      const dest = `${targetDir}/${chapterFilename(title, String(n), null)}`;
      try {
        mkdirSync(dirname(dest), { recursive: true });
        if (!existsSync(dest)) linkSync(`${src.path}/${file}`, dest);
        const r = await p.query(
          `INSERT INTO chapter (series_id, chapter_number, file_path, scanlator)
           VALUES ($1,$2,$3,NULL) ON CONFLICT (series_id, chapter_number) DO NOTHING`,
          [seriesId, n, dest]);
        if (r.rowCount ?? 0 > 0) { adopted++; claimed.add(n); }
      } catch (err) {
        console.log(`    could not adopt ${n}: ${err instanceof Error ? err.message.slice(0, 70) : String(err)}`);
      }
    }
  }
  if (!opts.dryRun && adopted > 0) {
    // Anything now held must leave the queue, or it downloads over the top of itself.
    const q = await p.query(
      `DELETE FROM wanted w USING chapter c
        WHERE c.series_id = w.series_id AND c.chapter_number = w.chapter_number
          AND w.series_id = $1 AND w.state <> 'done'`, [seriesId]);
    console.log(`adopted ${adopted} chapters, removed ${q.rowCount ?? 0} from the queue`);
  }
  return adopted;
}
