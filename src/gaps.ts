import { db } from "./db.js";
import { gql, sanitize } from "./suwayomi.js";
import { usableSources } from "./paid.js";
import { queryVariants } from "./match.js";
import { missingWholes, wholesCovered } from "./chapters.js";

const SEARCH = `mutation($src:LongString!,$q:String!){
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){ mangas{ id title url } } }`;

export type GapReport = {
  seriesId: number; title: string;
  /** Missing whole chapters inside the held range. */
  missing: number[];
  /** Already queued, so the source in use can supply them and nothing else is needed. */
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
  // Queued as parts is queued. Chapters 9 and 11 sat in the queue as 9.1 9.2 9.3 and
  // 11.1 11.2 and were still reported as needing another source, which sends you looking
  // for a source for chapters already on their way from the one in use.
  const queuedAll = wholesCovered((await p.query<{ n: string }>(
    "SELECT chapter_number AS n FROM wanted WHERE series_id = $1 AND state <> 'done'", [seriesId])).rows
    .map((r) => Number(r.n)));

  const missing = missingWholes(held);
  return {
    seriesId, title: s.title, missing,
    queued: missing.filter((n) => queuedAll.has(n)),
    unsupplied: missing.filter((n) => !queuedAll.has(n)),
  };
}
