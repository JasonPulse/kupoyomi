import { db } from "./db.js";
import { listEntries, pageEntries, readEntry } from "./unzip.js";

/**
 * The API the Paperback extension talks to.
 *
 * Shapes are deliberately flat and stable, because the extension mirrors them and lives
 * in a separate repo pinned to @paperback/types 0.8. Chapters are addressed by number,
 * never by a database id: the ledger is keyed on chapter number, so a series that later
 * moves to a different source keeps the same chapter ids and reading position.
 */
export type PbSeries = {
  id: string; title: string; description: string | null; status: string;
  cover: string | null; chapters: number; lastUpload: string | null;
};

export const listSeries = async (q?: string): Promise<PbSeries[]> =>
  (await db().query<PbSeries & { n: string }>(
    `SELECT s.id::text AS id, s.title, s.description, s.status,
            CASE WHEN s.cover_path IS NOT NULL THEN '/api/pb/cover/' || s.id ELSE NULL END AS cover,
            count(c.chapter_number)::int AS chapters,
            max(c.uploaded_at)::date::text AS "lastUpload"
       FROM series s LEFT JOIN chapter c ON c.series_id = s.id
      ${q ? "WHERE s.title ILIKE $1" : ""}
      GROUP BY s.id HAVING count(c.chapter_number) > 0
      ORDER BY max(c.uploaded_at) DESC NULLS LAST, s.title`,
    q ? [`%${q}%`] : [])).rows;

export const getSeries = async (id: number): Promise<PbSeries | null> =>
  (await db().query<PbSeries>(
    `SELECT s.id::text AS id, s.title, s.description, s.status,
            CASE WHEN s.cover_path IS NOT NULL THEN '/api/pb/cover/' || s.id ELSE NULL END AS cover,
            count(c.chapter_number)::int AS chapters,
            max(c.uploaded_at)::date::text AS "lastUpload"
       FROM series s LEFT JOIN chapter c ON c.series_id = s.id
      WHERE s.id = $1 GROUP BY s.id`, [id])).rows[0] ?? null;

export type PbChapter = {
  id: string; number: number; pages: number | null;
  scanlator: string | null; uploaded: string | null; read: boolean; lastPage: number;
};

export const getChapters = async (seriesId: number): Promise<PbChapter[]> =>
  (await db().query<PbChapter>(
    `SELECT c.chapter_number::text AS id, c.chapter_number::float8 AS number,
            c.page_count AS pages, c.scanlator, c.uploaded_at::date::text AS uploaded,
            COALESCE(r.completed, false) AS read, COALESCE(r.last_page, 0) AS "lastPage"
       FROM chapter c
       LEFT JOIN read_progress r
              ON r.series_id = c.series_id AND r.chapter_number = c.chapter_number
      WHERE c.series_id = $1 ORDER BY c.chapter_number DESC`, [seriesId])).rows;

const chapterFile = async (seriesId: number, chapter: string): Promise<string | null> =>
  (await db().query<{ file_path: string }>(
    "SELECT file_path FROM chapter WHERE series_id = $1 AND chapter_number = $2",
    [seriesId, chapter])).rows[0]?.file_path ?? null;

/**
 * Page list for a chapter, read out of the CBZ itself rather than from the stored page
 * count. The count can be stale or absent on adopted files, and the archive is the only
 * thing that actually knows.
 */
export async function getPages(seriesId: number, chapter: string): Promise<string[] | null> {
  const path = await chapterFile(seriesId, chapter);
  if (!path) return null;
  const pages = pageEntries(await listEntries(path));
  // Recorded so the reader and the library agree, and adopted files gain a real count.
  await db().query(
    "UPDATE chapter SET page_count = $3 WHERE series_id = $1 AND chapter_number = $2 AND (page_count IS DISTINCT FROM $3)",
    [seriesId, chapter, pages.length]);
  return pages.map((_, i) => `/api/pb/page/${seriesId}/${encodeURIComponent(chapter)}/${i}`);
}

export async function getPage(seriesId: number, chapter: string, index: number): Promise<{ body: Buffer; type: string } | null> {
  const path = await chapterFile(seriesId, chapter);
  if (!path) return null;
  const pages = pageEntries(await listEntries(path));
  const entry = pages[index];
  if (!entry) return null;
  const body = await readEntry(path, entry);
  const ext = entry.name.toLowerCase().split(".").pop() ?? "";
  const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp"
    : ext === "gif" ? "image/gif" : ext === "avif" ? "image/avif" : "image/jpeg";
  return { body, type };
}

/** Clears progress for a chapter, so it can be read again from the start. */
export async function clearProgress(seriesId: number, chapter: string): Promise<void> {
  await db().query("DELETE FROM read_progress WHERE series_id = $1 AND chapter_number = $2",
    [seriesId, chapter]);
}

/**
 * Progress lives here rather than on one device, which is the point of owning it.
 *
 * It only moves forward, so a reader reopening a chapter cannot rewind your place by
 * reporting page 1. The cost is that nothing here can mark a chapter unread, which is
 * what clearProgress is for.
 */
export async function setProgress(seriesId: number, chapter: string, page: number, completed: boolean): Promise<void> {
  await db().query(
    `INSERT INTO read_progress (series_id, chapter_number, last_page, completed, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (series_id, chapter_number)
       DO UPDATE SET last_page = GREATEST(read_progress.last_page, EXCLUDED.last_page),
                     completed = read_progress.completed OR EXCLUDED.completed,
                     updated_at = now()`,
    [seriesId, chapter, page, completed]);
}

/**
 * Marks everything up to and including a chapter as read, in one call.
 *
 * The case this exists for is a series you read elsewhere before Kupoyomi existed: two
 * hundred chapters, and no reader offers to mark them one at a time. Returns how many
 * rows it moved, so the caller can say something true about what happened.
 */
export async function setProgressUpTo(seriesId: number, chapter: string): Promise<number> {
  const r = await db().query(
    `INSERT INTO read_progress (series_id, chapter_number, last_page, completed, updated_at)
     SELECT c.series_id, c.chapter_number, COALESCE(c.page_count, 0), true, now()
       FROM chapter c
      WHERE c.series_id = $1 AND c.chapter_number <= $2
     ON CONFLICT (series_id, chapter_number)
       DO UPDATE SET last_page = GREATEST(read_progress.last_page, EXCLUDED.last_page),
                     completed = true, updated_at = now()`,
    [seriesId, chapter]);
  return r.rowCount ?? 0;
}

/** Highest chapter marked read, which is what a tracker wants to know. */
export const lastReadChapter = async (seriesId: number): Promise<number | null> => {
  const r = await db().query<{ n: string | null }>(
    `SELECT max(chapter_number)::text AS n FROM read_progress
      WHERE series_id = $1 AND completed`, [seriesId]);
  const n = r.rows[0]?.n;
  return n === null || n === undefined ? null : Number(n);
};

/**
 * What one binding currently offers, against what the series already holds.
 *
 * Loaded per binding from the page rather than up front: each answer is a live request to
 * a site, and a series with four sources should not make the page wait for all four.
 */
export async function bindingAvailability(bindingId: number): Promise<{
  sourceName: string; chapters: number; lo: number | null; hi: number | null;
  gaps: number; newBeyond: number; notCarried: number; error?: string;
}> {
  const { gql } = await import("./suwayomi.js");
  const { resolveManga } = await import("./match.js");
  const b = (await db().query<{ series_id: number; source_id: string; source_name: string; source_url: string | null; title: string }>(
    `SELECT b.series_id, b.source_id, b.source_name, b.source_url, s.title
       FROM series_binding b JOIN series s ON s.id = b.series_id WHERE b.id = $1`, [bindingId])).rows[0];
  if (!b) throw new Error("no such binding");

  const held = new Set((await db().query<{ chapter_number: string }>(
    "SELECT chapter_number FROM chapter WHERE series_id = $1", [b.series_id])).rows.map((r) => Number(r.chapter_number)));
  const heldMax = held.size > 0 ? Math.max(...held) : 0;

  try {
    if (!b.source_url) throw new Error("binding has no source url");
    const mangaId = await resolveManga(b.source_id, b.title, b.source_url);
    await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
      { id: mangaId }).catch(() => undefined);
    const nums = (await gql<{ manga: { chapters: { nodes: Array<{ chapterNumber: number | null }> } } }>(
      `{ manga(id:${mangaId}) { chapters { nodes { chapterNumber } } } }`)).manga.chapters.nodes
      .map((c) => c.chapterNumber).filter((n): n is number => n !== null);
    const whole = new Set(nums.filter(Number.isInteger));
    let gaps = 0;
    if (whole.size > 0) {
      for (let i = Math.min(...whole); i <= Math.max(...whole); i++) if (!whole.has(i)) gaps++;
    }
    return {
      sourceName: b.source_name, chapters: nums.length,
      lo: nums.length ? Math.min(...nums) : null, hi: nums.length ? Math.max(...nums) : null,
      gaps, newBeyond: nums.filter((n) => n > heldMax).length,
      notCarried: [...held].filter((n) => !nums.includes(n)).length,
    };
  } catch (err) {
    return { sourceName: b.source_name, chapters: 0, lo: null, hi: null, gaps: 0,
      newBeyond: 0, notCarried: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
