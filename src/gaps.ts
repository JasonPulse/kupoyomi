import { db } from "./db.js";
import { gql, installedSources, sanitize } from "./suwayomi.js";
import { queryVariants } from "./match.js";

const SEARCH = `mutation($src:LongString!,$q:String!){
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){ mangas{ id title url } } }`;

export type GapReport = {
  seriesId: number; title: string;
  /** Missing whole chapters inside the held range. */
  missing: number[];
  /** Already queued, so the primary source can supply them and nothing else is needed. */
  queued: number[];
  /** Neither held nor queued: only another source can close these. */
  unsupplied: number[];
};

export async function findGaps(seriesId: number): Promise<GapReport> {
  const p = db();
  const s = (await p.query<{ title: string }>("SELECT title FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!s) throw new Error(`no series ${seriesId}`);
  const held = (await p.query<{ n: string }>(
    "SELECT chapter_number AS n FROM chapter WHERE series_id = $1", [seriesId])).rows.map((r) => Number(r.n));
  const queuedAll = new Set((await p.query<{ n: string }>(
    "SELECT chapter_number AS n FROM wanted WHERE series_id = $1 AND state <> 'done'", [seriesId])).rows
    .map((r) => Number(r.n)));

  const whole = [...new Set(held.filter(Number.isInteger))].sort((a, b) => a - b);
  const have = new Set(whole);
  const missing: number[] = [];
  if (whole.length >= 2) {
    for (let i = whole[0]!; i <= whole[whole.length - 1]!; i++) if (!have.has(i)) missing.push(i);
  }
  return {
    seriesId, title: s.title, missing,
    queued: missing.filter((n) => queuedAll.has(n)),
    unsupplied: missing.filter((n) => !queuedAll.has(n)),
  };
}

export type GapSource = {
  sourceId: string; sourceName: string; mangaId: number; url: string; title: string;
  covers: number[];      // which of the unsupplied numbers this source actually has
  chapters: number;
};

/**
 * Finds sources that carry the specific chapters missing from a series.
 *
 * This is not a migration: the series keeps its primary binding and only the named
 * chapters come from elsewhere. Splicing in a whole other source would mix translation
 * groups across the run, which is the thing to avoid -- filling a named hole is not.
 */
export async function findGapSources(seriesId: number, concurrency = 6): Promise<GapSource[]> {
  const gaps = await findGaps(seriesId);
  if (gaps.unsupplied.length === 0) return [];
  const want = new Set(gaps.unsupplied);

  const sources = (await installedSources()).filter((s) => s.lang === "en" || s.lang === "all");
  const variants = queryVariants(gaps.title);
  const out: GapSource[] = [];
  const queue = [...sources];

  const worker = async (): Promise<void> => {
    for (;;) {
      const src = queue.shift();
      if (!src) return;
      try {
        let hit: { id: number; title: string; url: string } | undefined;
        for (const q of variants) {
          const r = await gql<{ fetchSourceManga: { mangas: Array<{ id: number; title: string; url: string }> } }>(
            SEARCH, { src: src.id, q });
          hit = r.fetchSourceManga.mangas.find(
            (m) => m.title === gaps.title || sanitize(m.title) === sanitize(gaps.title));
          if (hit) break;
        }
        if (!hit) continue;
        await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
          { id: hit.id }).catch(() => undefined);
        const nums = (await gql<{ manga: { chapters: { nodes: Array<{ chapterNumber: number | null }> } } }>(
          `{ manga(id:${hit.id}) { chapters { nodes { chapterNumber } } } }`)).manga.chapters.nodes
          .map((c) => c.chapterNumber).filter((n): n is number => n !== null);
        const covers = [...want].filter((n) => nums.includes(n)).sort((a, b) => a - b);
        if (covers.length > 0) {
          out.push({ sourceId: src.id, sourceName: src.displayName, mangaId: hit.id,
            url: hit.url, title: hit.title, covers, chapters: nums.length });
        }
      } catch { /* a source that errors simply offers nothing */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out.sort((a, b) => b.covers.length - a.covers.length);
}

/**
 * Queues the named chapters against a supplemental binding, leaving the primary alone.
 * The download path already resolves per binding, so nothing else needs to change.
 */
export async function queueGapFill(
  seriesId: number, source: { sourceId: string; sourceName: string; url: string }, numbers: number[],
): Promise<number> {
  const p = db();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const b = await client.query<{ id: number }>(
      `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, source_url, role)
       VALUES ($1,$2,$3,0,$4,'supplemental')
       ON CONFLICT (series_id, source_id, source_manga_id)
         DO UPDATE SET source_url = EXCLUDED.source_url RETURNING id`,
      [seriesId, source.sourceId, source.sourceName, source.url]);
    const bindingId = b.rows[0]!.id;
    let queued = 0;
    for (const n of numbers) {
      const r = await client.query(
        `INSERT INTO wanted (series_id, chapter_number, binding_id) VALUES ($1,$2,$3)
         ON CONFLICT (series_id, chapter_number) DO UPDATE SET binding_id = EXCLUDED.binding_id,
           state = 'pending', attempts = 0, last_error = NULL`,
        [seriesId, n, bindingId]);
      queued += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return queued;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
