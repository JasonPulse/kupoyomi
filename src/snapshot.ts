import { db } from "./db.js";
import { allManga, installedSources, installedExtensions, mangaChapters } from "./suwayomi.js";

/**
 * Freezes everything the old Suwayomi knows that the disk cannot tell us, before it
 * is torn down: library membership, per-chapter isDownloaded, the live source list
 * that decides what counts as stranded, and the unsanitized titles.
 *
 * Also seeds the declared extension set from whatever is installed right now, which
 * is the only record of which extensions this library actually depends on.
 */
export async function snapshot(): Promise<void> {
  const [manga, sources, extensions] = await Promise.all([
    allManga(), installedSources(), installedExtensions(),
  ]);
  // Only rows that carry state worth keeping. The other ~8600 are search stubs.
  const interesting = manga.filter((m) => m.inLibrary || m.downloadCount > 0);
  console.log(`capturing ${interesting.length} manga, ${sources.length} sources, ${extensions.length} extensions`);

  const p = db();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE legacy_chapter, legacy_manga, legacy_source");

    for (const s of sources) {
      await client.query(
        `INSERT INTO legacy_source (source_id, display_name, lang, is_nsfw) VALUES ($1,$2,$3,$4)
         ON CONFLICT (source_id) DO NOTHING`,
        [s.id, s.displayName, s.lang, s.isNsfw]);
    }
    for (const e of extensions) {
      await client.query(
        `INSERT INTO extension (pkg_name, repo, version, desired) VALUES ($1,$2,$3,true)
         ON CONFLICT (pkg_name) DO UPDATE SET repo = EXCLUDED.repo, version = EXCLUDED.version, desired = true`,
        [e.pkgName, e.repo, e.versionName]);
    }

    let chapters = 0;
    for (const m of interesting) {
      await client.query(
        `INSERT INTO legacy_manga (suwayomi_id, title, source_name, status, in_library, download_count)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [m.id, m.title, m.source?.displayName ?? null, m.status, m.inLibrary, m.downloadCount]);
      for (const c of await mangaChapters(m.id)) {
        await client.query(
          `INSERT INTO legacy_chapter (suwayomi_manga_id, chapter_number, is_downloaded, scanlator, uploaded_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [m.id, c.chapterNumber, c.isDownloaded, c.scanlator,
           c.uploadDate ? new Date(Number(c.uploadDate)) : null]);
        chapters++;
      }
    }
    await client.query("COMMIT");
    console.log(`captured ${interesting.length} manga and ${chapters} chapters`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
