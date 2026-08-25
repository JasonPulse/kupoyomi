import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { gql } from "./suwayomi.js";
import { resolveManga } from "./match.js";
import { buildCbz, comicInfo } from "./cbz.js";
import { chapterFilename } from "./remap.js";

/** Suwayomi's page proxy lives beside the graphql endpoint. */
const httpBase = (): string => config.suwayomiUrl.replace(/\/api\/graphql\/?$/, "");

type Binding = { id: number; series_id: number; source_id: string; source_name: string; source_url: string | null; title: string; folder: string; take_splits: boolean };

/**
 * Records every chapter the bound source offers that the ledger does not hold.
 *
 * Cheap and idempotent, so it is safe to run on a schedule: it is how new releases get
 * noticed at all.
 */
/**
 * Drops chapter numbers a source has plainly invented.
 *
 * Bbato lists "Chapter 5000" for A Couple of Cuckoos, whose next-highest chapter is 305.
 * It has 36 real pages, so it is a chapter, but the number is a placeholder or a typo on
 * their side. Taken at face value it made the series read as 0-5000 and turned gap
 * detection into a list of four thousand missing chapters.
 *
 * Judged against the source's own list rather than any absolute limit, because a real
 * series can genuinely be at chapter 1200. A number that sits hundreds above the next one
 * down is not part of the same run.
 */
export function withoutOutliers(offered: number[], gap = Number(process.env["OUTLIER_GAP"] ?? 200)): {
  kept: number[]; dropped: number[];
} {
  const sorted = [...new Set(offered)].sort((a, b) => a - b);
  const dropped: number[] = [];
  // From the top, because one absurd number can hide another.
  while (sorted.length >= 3) {
    const top = sorted[sorted.length - 1]!;
    const next = sorted[sorted.length - 2]!;
    if (top - next <= gap) break;
    dropped.push(sorted.pop()!);
  }
  return { kept: sorted, dropped: dropped.reverse() };
}

export async function scanWanted(opts: { seriesId?: number } = {}): Promise<void> {
  const p = db();
  const bindings = (await p.query<Binding>(
    `SELECT b.id, b.series_id, b.source_id, b.source_name, b.source_url, s.title, s.folder
       FROM series_binding b JOIN series s ON s.id = b.series_id
      WHERE b.role = 'primary' AND NOT s.muted ${opts.seriesId ? "AND s.id = $1" : ""}
      ORDER BY s.title`, opts.seriesId ? [opts.seriesId] : [])).rows;

  let queued = 0, checked = 0;
  for (const b of bindings) {
    let mangaId: number;
    try {
      if (!b.source_url) continue;
      mangaId = await resolveManga(b.source_id, b.title, b.source_url);
      await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
        { id: mangaId });
    } catch (err) {
      console.log(`  ${b.title.slice(0, 40)}: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      continue;
    }
    const offered = (await gql<{ manga: { chapters: { nodes: Array<{ chapterNumber: number | null }> } } }>(
      `{ manga(id:${mangaId}) { chapters { nodes { chapterNumber } } } }`)).manga.chapters.nodes
      .map((c) => c.chapterNumber).filter((n): n is number => n !== null);
    const { kept: offeredAll, dropped } = withoutOutliers(offered);
    // Whole chapters only. A decimal is nearly always one chapter split by a release
    // group, so 25.1 and 25.2 are chapter 25 twice and reading it means reading the same
    // pages again. Set FETCH_WHOLE_ONLY=false to take them.
    // Global rule, per-series exception. A source that publishes only halves would
    // otherwise stop delivering entirely.
    const wholeOnly = (process.env["FETCH_WHOLE_ONLY"] ?? "true") !== "false" && !b.take_splits;
    const offered2 = wholeOnly ? offeredAll.filter((n) => Number.isInteger(n)) : offeredAll;
    const skippedSplits = offeredAll.length - offered2.length;
    if (dropped.length > 0) {
      console.log(`  ${b.title.slice(0, 40)}: ignoring ${dropped.join(", ")} -- `
        + `${dropped.length === 1 ? "that number is" : "those numbers are"} hundreds above the rest of the run`);
    }
    if (skippedSplits > 0) {
      console.log(`  ${b.title.slice(0, 40)}: skipping ${skippedSplits} part-numbered chapter${
        skippedSplits === 1 ? "" : "s"}`);
    }
    const held = new Set((await p.query<{ chapter_number: string }>(
      "SELECT chapter_number FROM chapter WHERE series_id = $1", [b.series_id])).rows
      .map((r) => Number(r.chapter_number)));

    for (const n of offered2) {
      if (held.has(n)) continue;
      const r = await p.query(
        `INSERT INTO wanted (series_id, chapter_number, binding_id) VALUES ($1,$2,$3)
         ON CONFLICT (series_id, chapter_number) DO NOTHING`, [b.series_id, n, b.id]);
      queued += r.rowCount ?? 0;
    }
    checked++;
  }
  const total = (await p.query<{ n: string }>("SELECT count(*) n FROM wanted WHERE state <> 'done'")).rows[0];
  console.log(`checked ${checked} of ${bindings.length} bindings, queued ${queued} new; ${total?.n ?? 0} outstanding`);
}

export type WantedRow = {
  series_id: number; chapter_number: string; binding_id: number; source_id: string;
  source_name: string; source_url: string | null; title: string; folder: string; attempts: number;
};

/** The queue's serving order. Separated from the download loop so it can be proven. */
export async function nextWanted(limit?: number, blockSize?: number): Promise<WantedRow[]> {
  const block = Math.max(1, Number(blockSize ?? process.env["FETCH_BLOCK"] ?? 25));
  const maxAttempts = Math.max(1, Number(process.env["FETCH_MAX_ATTEMPTS"] ?? 6));
  // Round-robin by block, not one series start to finish.
  //
  // Ordering by title alone drained the alphabetically-first series completely before
  // touching the next, so a series near the end of the alphabet waited behind every
  // backlog in front of it: over a day for something the owner wanted to read.
  //
  // Each chapter is ranked within its own series and the rank divided by the block size
  // gives a block number, so no series gets its second 25 until every series has had a
  // first. No cursor and no new column, so nothing can drift out of step with the queue
  // or lose its place on a restart.
  //
  // The turn is series.served divided by the block size: how many blocks this series has
  // already taken in its current backlog. Everyone starts at turn 0, takes 25, moves to
  // turn 1, and the lowest turn is always served first.
  //
  // Two earlier attempts were wrong in opposite directions. Ranking only the OUTSTANDING
  // rows let the alphabetically-first series keep block 0 forever, because completed rows
  // left the set and the rest shifted up: A Couple of Cuckoos took 321 chapters while
  // Though I am an Inept Villainess sat on 4. Ranking rows against everything ever queued
  // fixed that and broke the mirror image, putting a series with 300 completions in block
  // 12 where it waited for every other series to catch up to it.
  //
  // A counter that resets when the backlog empties is neither: a turn is per backlog, so
  // a series rejoining with new chapters starts at the front instead of behind its own
  // history, and one with a thousand queued cycles through turns as it drains.
  return (await db().query<WantedRow>(
    `WITH q AS (
       SELECT w.series_id, w.chapter_number, w.binding_id, w.attempts,
              s.title, s.folder, s.served,
              row_number() OVER (PARTITION BY w.series_id ORDER BY w.chapter_number) - 1 AS idx
         FROM wanted w
         JOIN series s ON s.id = w.series_id
        WHERE w.state IN ('pending','failed','fetching') AND w.attempts < ${maxAttempts}
          -- A row waiting out its backoff is not a candidate yet.
          AND (w.retry_after IS NULL OR w.retry_after <= now())
          -- A muted series is one the owner has told to stop. Its backlog is deleted when
          -- it stops, so this is a backstop against rows arriving by another route.
          AND NOT s.muted
     )
     SELECT q.series_id, q.chapter_number, q.binding_id, b.source_id, b.source_name,
            b.source_url, q.title, q.folder, q.attempts
       FROM q JOIN series_binding b ON b.id = q.binding_id
      -- served + position is the row's turn, and the sum is what makes it hold still.
      -- Serving a chapter raises served by one and drops that row, which shifts every
      -- later row's position down by one, so the sum is unchanged. Ranking on position
      -- alone let a series keep turn 0 forever; ranking on served alone let a series that
      -- took a partial block take a full one straight after, so Justice for the Villainess
      -- got 38 chapters in what was meant to be a turn of 25.
      ORDER BY (q.served + q.idx) / ${block}, q.title, q.chapter_number
      ${limit ? `LIMIT ${Number(limit)}` : ""}`)).rows;
}

/**
 * Releases chapters left mid-download by a process that is no longer running.
 *
 * "fetching" means a process owns this row, and after a restart that is false for every
 * one of them. A pod rolled at 33 of 46 pages left a row claiming to be downloading for
 * as long as anyone cared to look at it: the downloads page showed it in flight with a
 * lifetime counting up, and nothing was doing anything.
 *
 * `olderThan` of 0 clears every one, which is right at startup because nothing can own a
 * row before the process begins. A tick passes a threshold instead, so a run in progress
 * is never reclaimed out from under itself; that also recovers a genuinely wedged fetch
 * without needing a restart.
 */
export async function reclaimStuck(olderThanMinutes = 0): Promise<number> {
  const r = await db().query(
    `UPDATE wanted SET state = 'pending', pages_done = 0, pages_total = NULL, started_at = NULL,
            retry_after = NULL
      WHERE state = 'fetching'
        AND (started_at IS NULL OR started_at < now() - ($1 || ' minutes')::interval)`,
    [String(Math.max(0, olderThanMinutes))]);
  const n = r.rowCount ?? 0;
  if (n > 0) console.log(`released ${n} chapter${n === 1 ? "" : "s"} left mid-download by a process that is gone`);
  return n;
}

/**
 * Puts given-up chapters back in the queue.
 *
 * Four attempts inside ninety minutes was no test of anything, so a source having a bad
 * afternoon left chapters permanently dead with no way back short of editing the database.
 * This is that way back, for one series or the whole library.
 */
export async function retryFailed(seriesId?: number, chapter?: string): Promise<number> {
  const max = Math.max(1, Number(process.env["FETCH_MAX_ATTEMPTS"] ?? 6));
  // One named chapter is a deliberate "try this now", so it ignores both the attempt limit
  // and the remaining backoff. Waiting six hours is the right default and the wrong answer
  // to somebody standing there having just fixed the source.
  const r = chapter !== undefined && seriesId !== undefined
    ? await db().query(
        `UPDATE wanted SET attempts = 0, retry_after = NULL, last_error = NULL, state = 'pending'
          WHERE series_id = $1 AND chapter_number = $2 AND state <> 'done'`, [seriesId, chapter])
    : await db().query(
        `UPDATE wanted SET attempts = 0, retry_after = NULL, last_error = NULL, state = 'pending'
          WHERE state = 'failed' AND attempts >= $1 ${seriesId ? "AND series_id = $2" : ""}`,
        seriesId ? [max, seriesId] : [max]);
  const n = r.rowCount ?? 0;
  console.log(`${n} chapter${n === 1 ? "" : "s"} put back in the queue`);
  return n;
}

/**
 * Downloads queued chapters.
 *
 * One source at a time within a source, several sources in parallel: the same shape as
 * Suwayomi's own downloader (maxSourcesInParallel = 6, all manga of a source handled
 * synchronously). That grouping is why this library has never been IP-banned, and
 * bypassing Suwayomi's downloader means reproducing it rather than inheriting it.
 */
export async function fetchWanted(opts: { limit?: number; concurrency?: number } = {}): Promise<void> {
  const p = db();
  const concurrency = opts.concurrency ?? 6;
  // Before selecting, so a row abandoned by an earlier process is a candidate again
  // rather than sitting in "fetching" until somebody notices.
  await reclaimStuck(Number(process.env["FETCH_STUCK_MINUTES"] ?? 30));
  const rows = await nextWanted(opts.limit);
  if (rows.length === 0) { console.log("nothing queued"); return; }

  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    const l = bySource.get(r.source_id);
    if (l) l.push(r); else bySource.set(r.source_id, [r]);
  }
  console.log(`${rows.length} chapters across ${bySource.size} sources, ${concurrency} sources at a time`);

  let done = 0, failed = 0, bytes = 0;
  const queues = [...bySource.values()];
  // How many failures in a row a series is allowed before this run gives up on it.
  //
  // 7th Time Loop sorts before every letter, so the block ordering served it first, and
  // its source timed out on every page. Every tick spent its whole batch of ten on that
  // one series and nothing else was attempted once: 24 rows queued and tried, every
  // other series at zero, no file written in ninety minutes. A source that is down must
  // cost a few slots, not the entire run.
  const giveUpAfter = Number(process.env["FETCH_SERIES_STRIKES"] ?? 3);
  const strikes = new Map<number, number>();
  let skipped = 0;

  const runSource = async (items: typeof rows): Promise<void> => {
    const resolved = new Map<number, number>();     // binding id -> local manga id
    for (const it of items) {
      if ((strikes.get(it.series_id) ?? 0) >= giveUpAfter) { skipped++; continue; }
      try {
        let mangaId = resolved.get(it.binding_id);
        if (mangaId === undefined) {
          if (!it.source_url) throw new Error("binding has no source url");
          mangaId = await resolveManga(it.source_id, it.title, it.source_url);
          await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
            { id: mangaId }).catch(() => undefined);
          resolved.set(it.binding_id, mangaId);
        }
        const want = Number(it.chapter_number);
        const chapters = (await gql<{ manga: { chapters: { nodes: Array<{ id: number; chapterNumber: number | null; name: string | null; scanlator: string | null; uploadDate: string | null }> } } }>(
          `{ manga(id:${mangaId}) { chapters { nodes { id chapterNumber name scanlator uploadDate } } } }`)).manga.chapters.nodes;
        const ch = chapters.find((c) => c.chapterNumber === want);
        if (!ch) throw new Error(`source no longer lists chapter ${want}`);

        const pages = (await gql<{ fetchChapterPages: { pages: string[] } }>(
          `mutation($id:Int!){ fetchChapterPages(input:{chapterId:$id}){ pages } }`, { id: ch.id })).fetchChapterPages.pages;
        if (pages.length === 0) throw new Error("chapter has no pages");
        // Marked in flight with its page count, so the UI can show progress rather
        // than a chapter vanishing for a minute and reappearing done.
        await p.query(
          `UPDATE wanted SET state='fetching', started_at=now(), pages_done=0, pages_total=$3
            WHERE series_id=$1 AND chapter_number=$2`,
          [it.series_id, it.chapter_number, pages.length]);

        const images: Array<{ name: string; data: Buffer }> = [];
        for (const [i, rel] of pages.entries()) {
          const res = await fetch(`${httpBase()}${rel}`, {
            signal: AbortSignal.timeout(Number(process.env["PAGE_TIMEOUT_MS"] ?? 60_000)),
          });
          if (!res.ok) throw new Error(`page ${i} returned ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png"
            : (res.headers.get("content-type") ?? "").includes("webp") ? "webp" : "jpg";
          images.push({ name: `${String(i + 1).padStart(3, "0")}.${ext}`, data: buf });
          if (i % 3 === 2 || i === pages.length - 1) {
            await p.query("UPDATE wanted SET pages_done=$3 WHERE series_id=$1 AND chapter_number=$2",
              [it.series_id, it.chapter_number, i + 1]);
          }
        }

        const uploaded = ch.uploadDate ? new Date(Number(ch.uploadDate)) : null;
        const cbz = buildCbz([
          { name: "ComicInfo.xml", data: comicInfo({
              series: it.title, number: it.chapter_number, title: ch.name,
              scanlator: ch.scanlator, uploaded, pageCount: images.length }) },
          ...images,
        ], uploaded ?? new Date(0));

        const dest = `${config.libraryRoot}/${it.folder}/${chapterFilename(it.title, it.chapter_number, ch.scanlator)}`;
        mkdirSync(dirname(dest), { recursive: true });
        // Written to a temporary name and renamed, so a page failing part-way through
        // can never leave a truncated archive that later looks complete.
        const tmp = `${dest}.part`;
        writeFileSync(tmp, cbz);
        renameSync(tmp, dest);
        bytes += cbz.length;

        await p.query(
          `INSERT INTO chapter (series_id, chapter_number, file_path, page_count, scanlator, binding_id, uploaded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (series_id, chapter_number) DO UPDATE SET file_path = EXCLUDED.file_path`,
          [it.series_id, it.chapter_number, dest, images.length, ch.scanlator, it.binding_id, uploaded]);
        await p.query(
          `UPDATE wanted SET state='done', finished_at=now(), attempts=attempts+1,
             last_error=NULL, retry_after=NULL WHERE series_id=$1 AND chapter_number=$2`,
          [it.series_id, it.chapter_number]);
        done++;
        // Its turn advances by one chapter. Divided by the block size this is the turn
        // number, so twenty-five successes move the series behind the others.
        await p.query("UPDATE series SET served = served + 1 WHERE id = $1", [it.series_id]);
        strikes.delete(it.series_id);   // it works after all, so the count starts over
        console.log(`  ok  ${it.title.slice(0, 34).padEnd(34)} ch ${it.chapter_number.padStart(8)}  ${images.length}p`);
      } catch (err) {
        failed++;
        const n = (strikes.get(it.series_id) ?? 0) + 1;
        strikes.set(it.series_id, n);
        if (n === giveUpAfter) {
          console.log(`  -- ${it.title.slice(0, 34)}: ${n} failures in a row, leaving the rest of it for the next run`);
        }
        const msg = err instanceof Error ? err.message.slice(0, 300) : String(err);
        // Minutes, then an hour, then six, then a day. Four attempts used to fit inside
        // ninety minutes, which is no test of whether a source has recovered.
        const waits = [15, 60, 360, 1440, 1440, 1440];
        const wait = waits[Math.min(it.attempts, waits.length - 1)]!;
        await p.query(
          `UPDATE wanted SET state='failed', attempts=attempts+1, last_error=$3,
             retry_after = now() + ($4 || ' minutes')::interval
            WHERE series_id=$1 AND chapter_number=$2`,
          [it.series_id, it.chapter_number, msg, String(wait)]);
        console.log(`  ERR ${it.title.slice(0, 34).padEnd(34)} ch ${it.chapter_number.padStart(8)}  ${msg.slice(0, 60)}`);
      }
    }
  };

  for (let i = 0; i < queues.length; i += concurrency) {
    await Promise.all(queues.slice(i, i + concurrency).map(runSource));
  }
  // A series with nothing left owes no turns. Clearing it means new chapters arriving
  // tomorrow start at the front rather than behind however much it downloaded today.
  const reset = await p.query(
    `UPDATE series SET served = 0 WHERE served > 0 AND NOT EXISTS (
       SELECT 1 FROM wanted w WHERE w.series_id = series.id
         AND w.state IN ('pending','failed','fetching') AND w.attempts < 4)`);
  console.log(`\ndownloaded ${done}, failed ${failed}, ${(bytes / 1048576).toFixed(0)}MB` +
    (skipped > 0 ? `, ${skipped} left for the next run behind a series that kept failing` : "") +
    ((reset.rowCount ?? 0) > 0 ? `, ${reset.rowCount} finished their backlog and rejoin at the front` : ""));
}
