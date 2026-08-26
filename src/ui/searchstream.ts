import type { ServerResponse } from "node:http";
import { gql } from "../suwayomi.js";
import { usableSources } from "../paid.js";

const SEARCH = `mutation($src:LongString!,$q:String!){
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){
    mangas{ id title url thumbnailUrl } } }`;

/**
 * Streams search hits as each source answers.
 *
 * Waiting for all 54 sources took 69 seconds and the slowest one set the floor, which
 * is long enough that nobody would use the page. Sent as they arrive instead, the first
 * results show up in about a second.
 */
export async function streamSearch(res: ServerResponse, query: string, concurrency = 10): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // usableSources, not installedSources: a paid source cannot be downloaded from, so
  // offering it as a search result is offering a dead end.
  const sources = await usableSources();
  send("start", { sources: sources.length });

  const queue = [...sources];
  let finished = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const src = queue.shift();
      if (!src) return;
      try {
        const r = await gql<{ fetchSourceManga: { mangas: Array<{ id: number; title: string; url: string; thumbnailUrl: string | null }> } }>(
          SEARCH, { src: src.id, q: query });
        for (const m of r.fetchSourceManga.mangas.slice(0, 8)) {
          send("hit", {
            sourceId: src.id, sourceName: src.displayName, nsfw: src.isNsfw,
            mangaId: m.id, title: m.title, url: m.url, thumb: `/thumb/${m.id}`,
          });
        }
      } catch { /* one dead source must not spoil the search */ }
      send("progress", { done: ++finished, total: sources.length, source: src.displayName });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  send("done", { sources: sources.length });
  res.end();
}

/**
 * Primes one search result and returns what only exists after priming: how many
 * chapters the source actually carries, plus a description. A source offering two
 * chapters is worse than useless and the count is the only way to know.
 */
/**
 * What a source offers measured against what a series already holds.
 *
 * This is the whole of what the migration page used to do, and the only reason that page
 * existed. A raw chapter count cannot answer "should I move to this source": 129 means
 * nothing without knowing that 15 of them are past your highest and 9 fill your holes.
 *
 * Three separate facts, never one score. Chapters past your highest are the reason to
 * move; chapters inside your range that you lack are a bonus; chapters you hold that the
 * source does not carry cost nothing at all, because the files stay on disk. Smearing
 * them into a single number is what made the old library offer migrations that lost you
 * chapters.
 */
async function against(seriesId: number, offeredAll: number[]): Promise<{
  newBeyond: number; fillsGaps: number; notCarried: number; held: number; heldMax: number | null;
}> {
  const { db } = await import("../db.js");
  const held = new Set((await db().query<{ n: string }>(
    "SELECT chapter_number AS n FROM chapter WHERE series_id = $1", [seriesId])).rows.map((r) => Number(r.n)));
  // Count only what would actually be fetched. A whole-only series showed "+11 fills" for
  // a source whose eleven were nine part-numbered chapters and two real ones, so the
  // column promised eleven chapters and the queue asked for two.
  const takesSplits = (await db().query<{ t: boolean }>(
    "SELECT take_splits AS t FROM series WHERE id = $1", [seriesId])).rows[0]?.t ?? false;
  const offered = takesSplits ? offeredAll : offeredAll.filter((n) => Number.isInteger(n));
  const heldMax = held.size > 0 ? Math.max(...held) : null;
  const offeredSet = new Set(offered);
  return {
    newBeyond: heldMax === null ? offered.length : offered.filter((n) => n > heldMax).length,
    fillsGaps: heldMax === null ? 0 : offered.filter((n) => n <= heldMax && !held.has(n)).length,
    notCarried: [...held].filter((n) => !offeredSet.has(n)).length,
    held: held.size,
    heldMax,
  };
}

export async function mangaDetail(mangaId: number, seriesId?: number): Promise<{
  chapters: number; total: number; highest: number | null;
  description: string | null; status: string; genres: string[]; lastUpload: string | null;
  newBeyond?: number; fillsGaps?: number; notCarried?: number; held?: number; heldMax?: number | null;
}> {
  await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
    { id: mangaId }).catch(() => undefined);
  const d = await gql<{ manga: { description: string | null; status: string; genre: string[];
    chapters: { totalCount: number; nodes: Array<{ uploadDate: string | null; chapterNumber: number | null }> } } }>(
    `{ manga(id:${mangaId}) { description status genre chapters { totalCount nodes { uploadDate chapterNumber } } } }`);
  const dates = d.manga.chapters.nodes.map((c) => c.uploadDate).filter((x): x is string => !!x).map(Number);
  const nums = d.manga.chapters.nodes.map((c) => c.chapterNumber)
    .filter((n): n is number => n !== null && n >= 0);
  const unique = new Set(nums);
  const cmp = seriesId ? await against(seriesId, [...unique]) : undefined;
  return {
    // The distinct chapter numbers, not the row count. ComicK reported 319 chapters for
    // a series that stops at 93: every chapter is uploaded several times over, once per
    // language and group. A raw count makes the worst entry on the page look the best,
    // and it is the number a person uses to choose.
    chapters: unique.size > 0 ? unique.size : d.manga.chapters.totalCount,
    total: d.manga.chapters.totalCount,
    highest: nums.length > 0 ? Math.max(...nums) : null,
    description: d.manga.description,
    status: d.manga.status,
    genres: d.manga.genre ?? [],
    lastUpload: dates.length > 0 ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : null,
    ...(cmp ?? {}),
  };
}
