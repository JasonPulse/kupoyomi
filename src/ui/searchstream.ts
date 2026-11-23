import type { ServerResponse } from "node:http";
import { gql, primeManga } from "../suwayomi.js";
import { usableSources } from "../paid.js";
import { compareOffering, heldFor } from "../chapters.js";
import { searchEach } from "../searchall.js";

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

  let finished = 0;
  await searchEach(sources, query, concurrency, (src, hits) => {
    for (const m of (hits ?? []).slice(0, 8)) {
      send("hit", {
        sourceId: src.id, sourceName: src.displayName, nsfw: src.isNsfw,
        mangaId: m.id, title: m.title, url: m.url, thumb: `/thumb/${m.id}`,
      });
    }
    send("progress", { done: ++finished, total: sources.length, source: src.displayName });
  });
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
  const held = await heldFor(seriesId);
  // Counted against everything the source lists, because that is what the downloader now
  // takes. Filtering here to match an old whole-only rule is how this column came to
  // promise a different number of chapters from the one the queue asked for.
  return { ...compareOffering(offeredAll, held), held: held.size };
}

export async function mangaDetail(mangaId: number, seriesId?: number): Promise<{
  chapters: number; total: number; highest: number | null;
  description: string | null; status: string; genres: string[]; lastUpload: string | null;
  newBeyond?: number; fillsGaps?: number; notCarried?: number; held?: number; heldMax?: number | null;
}> {
  await primeManga(mangaId);
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
