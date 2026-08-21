import { config } from "./config.js";
import { db } from "./db.js";
import { scanLegacyTree } from "./disk.js";
import { sanitize } from "./suwayomi.js";

/**
 * Canonical folder and file names. Suwayomi flattens every illegal character to '_',
 * which is why the old tree has "Tsukimichi_ Moonlit Fantasy". Ours keeps the
 * separator readable and drops punctuation that carries no meaning in a filename.
 */
export const canonical = (title: string): string =>
  title
    .replace(/[\\/]/g, "-")
    .replace(/:\s*/g, " - ")
    .replace(/["*?<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

type LegacyManga = { suwayomi_id: number; title: string; source_name: string | null; status: string | null; in_library: boolean };
type LegacyChapter = { chapter_number: string | null; name: string | null; page_count: number | null; scanlator: string | null; uploaded_at: Date | null };

/** Suwayomi's on-disk name for a chapter: "{scanlator}_{name}.cbz", or "{name}.cbz". */
const legacyBasename = (ch: LegacyChapter): string => {
  const base = ch.scanlator ? `${sanitize(ch.scanlator)}_${sanitize(ch.name ?? "")}` : sanitize(ch.name ?? "");
  return `${base}.cbz`;
};

/**
 * One file per chapter number, per the ledger's primary key. Which scanlation wins
 * follows the agreed rule: the group that has done the most chapters of this series
 * is preferred, and when it has not touched a chapter the earliest upload wins.
 * Consistency where possible, availability over consistency where not.
 */
const pickWinners = (chapters: LegacyChapter[]): Map<string, LegacyChapter> => {
  const downloaded = chapters.filter((c) => c.chapter_number !== null);
  const perGroup = new Map<string, number>();
  for (const c of downloaded) {
    if (c.scanlator) perGroup.set(c.scanlator, (perGroup.get(c.scanlator) ?? 0) + 1);
  }
  const preferred = [...perGroup.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const byNumber = new Map<string, LegacyChapter[]>();
  for (const c of downloaded) {
    const k = c.chapter_number!;
    const list = byNumber.get(k);
    if (list) list.push(c); else byNumber.set(k, [c]);
  }

  const winners = new Map<string, LegacyChapter>();
  for (const [num, options] of byNumber) {
    const fromPreferred = options.find((o) => o.scanlator === preferred);
    if (fromPreferred) { winners.set(num, fromPreferred); continue; }
    const dated = options.filter((o) => o.uploaded_at !== null)
      .sort((a, b) => a.uploaded_at!.getTime() - b.uploaded_at!.getTime());
    winners.set(num, dated[0] ?? options[0]!);
  }
  return winners;
};

export async function seedLedger(): Promise<void> {
  // Read entirely from the snapshot, never from Suwayomi: this has to keep working
  // after the old instance is deleted.
  const p = db();
  // display name -> Suwayomi source id. The disk only carries display names, but the
  // binding must hold the real id or later upserts keyed on it will not match.
  const sourceIds = new Map(
    (await p.query<{ source_id: string; display_name: string }>(
      "SELECT source_id, display_name FROM legacy_source")).rows.map((r) => [r.display_name, r.source_id]));
  const liveSources = new Set(sourceIds.keys());
  const legacy = (await p.query<LegacyManga>(
    "SELECT suwayomi_id, title, source_name, status, in_library FROM legacy_manga")).rows;
  const disk = await scanLegacyTree();

  let seeded = 0, chapters = 0, skippedDead = 0, skippedNoRow = 0, phantom = 0;
  const client = await p.connect();
  try {
    for (const d of disk) {
      if (!d.sourceDir || d.cbzCount === 0) continue;
      if (!liveSources.has(d.sourceDir)) { skippedDead++; continue; }   // stranded: needs a human
      const row = legacy.find((m) => sanitize(m.title) === d.folder && m.source_name === d.sourceDir)
        ?? legacy.find((m) => sanitize(m.title) === d.folder);
      if (!row) { skippedNoRow++; continue; }

      const ch = (await client.query<LegacyChapter>(
        `SELECT chapter_number, name, page_count, scanlator, uploaded_at FROM legacy_chapter
          WHERE suwayomi_manga_id = $1 AND is_downloaded`, [row.suwayomi_id])).rows;
      const winners = pickWinners(ch);
      if (winners.size === 0) continue;

      // Suwayomi's isDownloaded drifts from reality: it flags chapters whose files
      // are long gone. The ledger means "this file is here", so anything that does
      // not resolve to a real .cbz is dropped and resurfaces later as a gap.
      const present = new Set(d.files);

      await client.query("BEGIN");
      try {
        const s = await client.query<{ id: number }>(
          `INSERT INTO series (title, folder, status) VALUES ($1,$2,$3)
           ON CONFLICT (folder) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
          [row.title, canonical(row.title), row.status ?? "UNKNOWN"]);
        const seriesId = s.rows[0]!.id;
        const b = await client.query<{ id: number }>(
          `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, role)
           VALUES ($1,$2,$3,$4,'primary')
           ON CONFLICT (series_id, source_id, source_manga_id) DO UPDATE SET role = 'primary' RETURNING id`,
          [seriesId, sourceIds.get(d.sourceDir) ?? d.sourceDir, d.sourceDir, row.suwayomi_id]);
        const bindingId = b.rows[0]!.id;

        for (const [num, c] of winners) {
          const basename = legacyBasename(c);
          if (!present.has(basename)) { phantom++; continue; }
          await client.query(
            `INSERT INTO chapter
               (series_id, chapter_number, file_path, page_count, scanlator, binding_id, uploaded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (series_id, chapter_number) DO NOTHING`,
            [seriesId, num, `${config.legacyRoot}/${d.sourceDir}/${d.folder}/${basename}`,
             c.page_count, c.scanlator, bindingId, c.uploaded_at]);
          chapters++;
        }
        await client.query("COMMIT");
        seeded++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
  console.log(`seeded ${seeded} series and ${chapters} chapters`);
  console.log(`skipped ${skippedDead} stranded on dead sources (need confirmation), ${skippedNoRow} with no snapshot row`);
  console.log(`dropped ${phantom} chapters Suwayomi flagged as downloaded with no file on disk`);
}
