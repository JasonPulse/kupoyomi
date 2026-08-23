import { writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { gql } from "./suwayomi.js";
import { resolveManga } from "./match.js";
import { listEntries, pageEntries, readEntry } from "./unzip.js";
import { imageSize, coverScore } from "./imgsize.js";

const httpBase = (): string => config.suwayomiUrl.replace(/\/api\/graphql\/?$/, "");

/**
 * Pulls the synopsis and cover for a series from its bound source.
 *
 * The cover is written into the series folder as cover.jpg, which is what Komga, Kavita
 * and anything else look for. That is the whole of komf's job in this stack, so owning it
 * here is what lets komf go.
 */
/**
 * Whether a description is site copy rather than a synopsis.
 *
 * Descriptions come straight from the source, and aggregators write for search engines
 * instead of readers: "breathtaking visuals", a score out of five, an invitation to read
 * online and bookmark the page. That is not what the series is about, and storing it
 * means the real synopsis never gets looked for again.
 *
 * Two signals have to agree, because a genuine synopsis can mention a title or a rating
 * in passing and should not be thrown away for it.
 */
export function looksLikeSiteCopy(text: string): boolean {
  const t = text.toLowerCase();
  const tells = [
    /\bread (?:it )?(?:online|for free|the latest)/,
    /\byou can read\b/,
    /\b(?:bookmark|scroll down|click here|sign ?up)\b/,
    /\b\d(?:\.\d)?\s*(?:\/|out of)\s*(?:5|10)\b/,
    /\b(?:anidb|myanimelist|mal|anilist|goodreads)\b/,
    /\bupdated? (?:daily|weekly|regularly)\b/,
    /\b(?:manga|manhwa|manhua|webtoon|comic)s? (?:online|website|site|reader)\b/,
    /\b(?:latest|newest) chapters?\b/,
    /\b(?:high|hd) quality\b/,
    /\bbreathtaking\b/,
    /\bmust[- ]read\b/,
    /\bfor free\b/,
  ];
  const hits = tells.filter((re) => re.test(t)).length;
  // A short blob that trips even one of these is almost certainly not a synopsis.
  return hits >= 2 || (hits >= 1 && t.length < 240);
}

/**
 * Cover and synopsis taken from the files themselves, needing no source at all.
 *
 * An archived series has no binding by design -- there will never be another chapter, so
 * there is nothing for a binding to receive. That left it permanently without cover art,
 * because every route to a cover went through a source. The first page of the earliest
 * chapter is a cover: it is what the scanlator put there, and it is on disk already.
 */
async function localMetadata(seriesId: number, folder: string): Promise<{ cover: string | null; description: string | null }> {
  const dir = `${config.libraryRoot}/${folder}`;
  const first = (await db().query<{ file_path: string }>(
    "SELECT file_path FROM chapter WHERE series_id = $1 ORDER BY chapter_number LIMIT 1",
    [seriesId])).rows[0];

  let cover: string | null = null;
  // A cover.jpg already sitting in the folder is either ours from a previous run or one
  // komf left behind. Either way it is a real cover, so adopt it rather than redo it.
  if (existsSync(`${dir}/cover.jpg`)) cover = `${dir}/cover.jpg`;

  let description: string | null = null;
  if (first) {
    try {
      const entries = await listEntries(first.file_path);
      if (!cover) {
        // The best-shaped of the first few pages rather than simply the first. On a
        // webtoon every page is one long strip, and its title panel is usually the one
        // page shaped anything like a cover.
        let best: Buffer | null = null;
        let bestScore = Infinity;
        for (const page of pageEntries(entries).slice(0, 8)) {
          const data = await readEntry(first.file_path, page);
          const score = coverScore(imageSize(data));
          if (score < bestScore) { bestScore = score; best = data; }
          if (bestScore < 0.35) break;                   // close enough to a page shape
        }
        if (best) {
          mkdirSync(dir, { recursive: true });
          const tmp = `${dir}/.cover.part`;
          writeFileSync(tmp, best);
          renameSync(tmp, `${dir}/cover.jpg`);
          cover = `${dir}/cover.jpg`;
        }
      }
      // Suwayomi wrote a ComicInfo.xml into most adopted files, and its Summary is the
      // synopsis the source had at download time. Stale beats blank.
      const ci = entries.find((e) => /^comicinfo\.xml$/i.test(e.name));
      if (ci) {
        const xml = (await readEntry(first.file_path, ci)).toString("utf8");
        const m = /<Summary>([\s\S]*?)<\/Summary>/i.exec(xml);
        if (m?.[1]) {
          description = m[1]
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim() || null;
        }
      }
    } catch { /* an unreadable archive is not worth failing the refresh over */ }
  }
  return { cover, description };
}

export async function refreshMetadata(seriesId: number): Promise<{ cover: boolean; description: boolean }> {
  const p = db();
  const s = (await p.query<{ title: string; folder: string }>(
    "SELECT title, folder FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!s) throw new Error(`no series ${seriesId}`);
  const b = (await p.query<{ source_id: string; source_url: string | null }>(
    "SELECT source_id, source_url FROM series_binding WHERE series_id = $1 AND role = 'primary'",
    [seriesId])).rows[0];

  // No binding means an archived series, and it used to return here empty-handed. The
  // files are still on disk, so there is no reason for it to have no cover.
  if (!b?.source_url) {
    const local = await localMetadata(seriesId, s.folder);
    await p.query(
      `UPDATE series SET description = COALESCE(description, $2),
         cover_path = COALESCE($3, cover_path), metadata_at = now() WHERE id = $1`,
      [seriesId, local.description, local.cover]);
    return { cover: local.cover !== null, description: local.description !== null };
  }

  const mangaId = await resolveManga(b.source_id, s.title, b.source_url);
  await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:false,fetchManga:true}){ clientMutationId } }`,
    { id: mangaId }).catch(() => undefined);
  const d = (await gql<{ manga: { description: string | null; status: string; thumbnailUrl: string | null } }>(
    `{ manga(id:${mangaId}) { description status thumbnailUrl } }`)).manga;
  if (d.description && looksLikeSiteCopy(d.description)) {
    console.log(`  ignoring the description from this source: it is site copy, not a synopsis`);
    d.description = null;
  }

  let coverPath: string | null = null;
  if (d.thumbnailUrl) {
    try {
      const r = await fetch(`${httpBase()}${d.thumbnailUrl}`);
      if (r.ok) {
        const dir = `${config.libraryRoot}/${s.folder}`;
        mkdirSync(dir, { recursive: true });
        // Written then renamed, so a reader scanning mid-download never sees a partial
        // image and cache it.
        const tmp = `${dir}/.cover.part`;
        writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
        renameSync(tmp, `${dir}/cover.jpg`);
        coverPath = `${dir}/cover.jpg`;
      }
    } catch { /* a missing cover is not worth failing the refresh over */ }
  }

  // A source that answers without a thumbnail, or whose image host is down, must not
  // leave the series blank when the first page is sitting right there.
  let localDesc: string | null = null;
  if (!coverPath || !d.description) {
    const local = await localMetadata(seriesId, s.folder);
    coverPath = coverPath ?? local.cover;
    localDesc = local.description;
  }

  await p.query(
    `UPDATE series SET description = COALESCE($2, description, $5),
       cover_path = COALESCE($3, cover_path),
       status = CASE WHEN $4 <> 'UNKNOWN' THEN $4 ELSE status END,
       metadata_at = now() WHERE id = $1`,
    [seriesId, d.description, coverPath, d.status, localDesc]);
  return { cover: coverPath !== null, description: !!(d.description ?? localDesc) };
}


/**
 * Fills in covers and synopses for series that have none. Paced, because each one is a
 * search plus a fetch against a real site, and there is no hurry.
 *
 * Every series is eligible, including archived ones with no binding: those are answered
 * from their own files. Requiring a binding here is what left archived series blank.
 */
export async function refreshAllMetadata(opts: { force?: boolean; limit?: number } = {}): Promise<void> {
  const p = db();
  const rows = (await p.query<{ id: number; title: string }>(
    `SELECT s.id, s.title FROM series s
      WHERE ${opts.force ? "TRUE" : "(s.cover_path IS NULL OR s.description IS NULL)"}
      ORDER BY s.title ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ""}`)).rows;
  console.log(`${rows.length} series need metadata`);
  let cover = 0, desc = 0, failed = 0;
  for (const r of rows) {
    try {
      const got = await refreshMetadata(r.id);
      if (got.cover) cover++;
      if (got.description) desc++;
      console.log(`  ${got.cover ? "cover" : "     "} ${got.description ? "text" : "    "}  ${r.title.slice(0, 52)}`);
    } catch (err) {
      failed++;
      console.log(`  ERR  ${r.title.slice(0, 40)}: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
    }
  }
  console.log(`covers ${cover}, synopses ${desc}, failed ${failed}`);
}
