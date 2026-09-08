import { db } from "./db.js";

/**
 * Every rule about whole chapters and part-numbered ones, in one place.
 *
 * These rules were written five separate times, each slightly differently, and each copy
 * had to be found and fixed on its own. The cost was concrete: MangaDex carries a series
 * as 7.1 7.2 7.3, 8.1 8.2 8.3, 9.1 9.2 9.3, 11.1 11.2 and offers no whole 7, 8, 9 or 11.
 * Fixing the downloader made those chapters reachable, and the migrate page still showed
 * the source as covering none of them, the source preview still listed them as gaps, the
 * Paperback API still counted them as gaps, and the gap report still called them missing
 * after they were downloaded, because each of those did its own version of the same test.
 *
 * A part belongs to the chapter it is part of. Everything below follows from that, and
 * nothing outside this file should decide it again.
 */

/**
 * The whole chapters a list of numbers covers. A part covers the chapter it belongs to,
 * so 7.1 covers 7, and holding 7.1 means chapter 7 is not missing.
 *
 * This is the right question for anything about coverage or gaps: what does this set of
 * numbers actually give a reader.
 */
export const wholesCovered = (nums: Iterable<number>): Set<number> =>
  new Set([...nums].map(Math.trunc));

/**
 * What to take from a source, given what is already held.
 *
 * A decimal is usually one chapter split by a release group, so taking 25.1 and 25.2
 * alongside 25 means reading the same pages twice. Refusing every decimal on sight is a
 * different rule and a worse one: it drops chapters that exist in no other form.
 *
 * A part is refused only when there is a whole to prefer, meaning the source offers that
 * whole or we already hold it. Otherwise the parts are the chapter.
 */
export const preferWholeChapters = (offered: number[], held: Set<number>): number[] => {
  const wholes = new Set(offered.filter((n) => Number.isInteger(n)));
  return offered.filter((n) => Number.isInteger(n)
    || (!wholes.has(Math.trunc(n)) && !held.has(Math.trunc(n))));
};

/**
 * Is this part made redundant by a whole chapter already on disk.
 *
 * Holding whole 8 means 8.1 and 8.2 are the same pages again. Adoption uses this to leave
 * such files alone rather than counting them as something a folder still owes.
 */
export const supersededByWhole = (n: number, held: Set<number>): boolean =>
  !Number.isInteger(n) && held.has(Math.trunc(n));

/**
 * Whole chapters we hold only as parts.
 *
 * Holding 8.1 and 8.2 is holding chapter 8, so fetching the whole 8 fetches those pages a
 * third time. It was queued for exactly that and kept failing against a source that 500s.
 */
export const wholesHeldAsParts = (held: Iterable<number>): Set<number> =>
  new Set([...held].filter((n) => !Number.isInteger(n)).map(Math.trunc));

/**
 * Whole chapters missing between the first and last a list covers.
 *
 * Only whole numbers are reported. A source's decimals are its own invention, one site
 * splits chapter 12 into 12.1 and 12.2 where another does not, so calling a missing 12.2
 * a hole would invent gaps nobody is missing. The ceiling comes from every number, not
 * only the whole ones: a series holding 1 to 8 and then 12.3 reported no gaps at all,
 * because the highest whole chapter was 8 and the range stopped there. Holding 12.3 is
 * proof that 9 through 12 exist and are missing.
 */
export const missingWholes = (nums: Iterable<number>): number[] => {
  const all = [...nums];
  if (all.length === 0) return [];
  const have = wholesCovered(all);
  const first = Math.min(...have);
  const ceiling = Math.floor(Math.max(...all));
  const out: number[] = [];
  for (let i = first; i <= ceiling; i++) if (!have.has(i)) out.push(i);
  return out;
};

/** Is this number a part of a chapter rather than a whole one. */
export const isPart = (n: number): boolean => !Number.isInteger(n);

/** The whole chapters a set of parts belongs to, each listed once. */
export const basesOf = (nums: Iterable<number>): number[] =>
  [...new Set([...nums].filter(isPart).map(Math.trunc))];

/**
 * Is this whole chapter already covered by parts on disk.
 *
 * The mirror of supersededByWhole, and the reason it lives here too: read in the other
 * direction it is the same rule, and the two drifting apart is exactly the failure this
 * module exists to prevent.
 */
export const supersededByParts = (n: number, heldAsParts: Set<number>): boolean =>
  Number.isInteger(n) && heldAsParts.has(n);

/**
 * The rule in SQL, for statements that cannot call into this module.
 *
 * Two queries need it: superseding parts when a whole arrives, and pruning parts across
 * the library. Written inline they were two more copies to keep in step, so they are
 * these constants instead.
 */
export const IS_PART_SQL = "chapter_number <> trunc(chapter_number)";
export const BASE_OF_SQL = "trunc(chapter_number)";

/**
 * What a source offers measured against what a series holds.
 *
 * Written four times over: the migrate page, the series page's per-binding row, the
 * importer's stored comparison, and the CLI's compare. All four counted by exact number,
 * so a source carrying chapter 7 as 7.1 7.2 7.3 reported chapter 7 as "not carried" while
 * carrying it, and counted three fills for one chapter.
 *
 * Three separate facts, never one score. Chapters past your highest are the reason to
 * move. Chapters inside your range that you lack are a bonus. Chapters you hold that the
 * source lacks cost nothing, because the files stay on disk. Smearing them into a single
 * number is what made the old library offer migrations that lost chapters.
 */
export type Comparison = {
  newBeyond: number;
  fillsGaps: number;
  notCarried: number;
  heldMax: number | null;
};

export const compareOffering = (offered: number[], held: Set<number>): Comparison => {
  // Counted per chapter, not per file. Three parts of chapter 7 are one chapter gained.
  const gives = wholesCovered(offered);
  const has = wholesCovered(held);
  const heldMax = has.size > 0 ? Math.max(...has) : null;
  const chapters = [...gives];
  return {
    newBeyond: heldMax === null ? chapters.length : chapters.filter((n) => n > heldMax).length,
    fillsGaps: heldMax === null ? 0 : chapters.filter((n) => n <= heldMax && !has.has(n)).length,
    notCarried: [...has].filter((n) => !gives.has(n)).length,
    heldMax,
  };
};

/**
 * The chapter numbers a series holds.
 *
 * Four modules ran this same SELECT to answer the same question, and the answer feeds
 * every comparison, so they had four chances to disagree about it.
 */
export const heldFor = async (seriesId: number): Promise<Set<number>> =>
  new Set((await db().query<{ n: string }>(
    "SELECT chapter_number AS n FROM chapter WHERE series_id = $1", [seriesId],
  )).rows.map((r) => Number(r.n)));
