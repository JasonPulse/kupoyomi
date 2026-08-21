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

/** Progress lives here rather than on one device, which is the point of owning it. */
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
