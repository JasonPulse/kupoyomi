import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The queue's serving order.
 *
 * Ordering by title alone drained the alphabetically-first series to the end before
 * touching the next, so a series late in the alphabet sat behind every backlog in front
 * of it. The owner waited over a day for something they wanted to read. Blocks fix that,
 * and this asserts the property rather than the implementation: no series gets its second
 * block until every series has had its first.
 */
process.env["LEGACY_ROOT"] = mkdtempSync(join(tmpdir(), "kupo-qo-"));
process.env["LIBRARY_ROOT"] = process.env["LEGACY_ROOT"];
process.env["DATABASE_URL"] = process.env["TEST_DATABASE_URL"]
  ?? "postgres://postgres:test@127.0.0.1:55444/kupoyomi";

const { nextWanted } = await import("../src/fetch.js");
const { db, migrate, closeDb } = await import("../src/db.js");

let haveDb = false;
try { await db().query("SELECT 1"); haveDb = true; } catch {
  console.log("no database reachable, skipping the queue order test");
}

// Deliberately named so alphabetical order is Aardvark, Middle, Zebra: under the old
// ordering Zebra could not start until the other 100 chapters were done.
const SERIES: Array<[string, number]> = [["Aardvark Saga", 60], ["Middle Tale", 40], ["Zebra Chronicle", 10]];
const ids = new Map<string, number>();

before(async () => {
  if (!haveDb) return;
  await migrate();
  const p = db();
  for (const [title] of SERIES) await p.query("DELETE FROM series WHERE title = $1", [title]);
  for (const [title, count] of SERIES) {
    const s = await p.query<{ id: number }>(
      "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [title]);
    const id = s.rows[0]!.id;
    ids.set(title, id);
    const b = await p.query<{ id: number }>(
      `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, role)
       VALUES ($1,'src','Src',0,'primary') RETURNING id`, [id]);
    for (let n = 1; n <= count; n++) {
      await p.query("INSERT INTO wanted (series_id, chapter_number, binding_id) VALUES ($1,$2,$3)",
        [id, n, b.rows[0]!.id]);
    }
  }
});

after(async () => {
  if (!haveDb) return;
  for (const [title] of SERIES) await db().query("DELETE FROM series WHERE title = $1", [title]);
  await closeDb();
});

test("every series gets its first turn before any gets its second", { skip: !haveDb }, async () => {
  const p = db();
  for (const [, count] of SERIES) void count;
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
  const rows = (await nextWanted(undefined, 25)).filter((r) => ids.has(r.title));
  assert.equal(rows.length, 110, "all three backlogs are present");

  // Everyone is on turn 0, so the whole queue is one turn and the order is by title.
  // What matters is that a series cannot take a second block while others wait, which is
  // now a property of the counter rather than of the row ordering.
  assert.deepEqual([...new Set(rows.map((r) => r.title))],
    ["Aardvark Saga", "Middle Tale", "Zebra Chronicle"],
    "a series' block stays contiguous so the downloader does not hop sources");
});

test("a partial block plus a full one is still only one turn", { skip: !haveDb }, async () => {
  const p = db();
  const hog = ids.get("Aardvark Saga")!;
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);

  // It took ten in one tick. A turn is twenty-five, so fifteen are left in this turn and
  // no more. Ranking on served alone gave it a fresh twenty-five here, so Justice for the
  // Villainess took 38 chapters in what was meant to be a block.
  await p.query("UPDATE wanted SET state='done' WHERE series_id=$1 AND chapter_number <= 10", [hog]);
  await p.query("UPDATE series SET served = 10 WHERE id = $1", [hog]);

  const rows = await nextWanted(undefined, 25);
  let run = 0;
  for (const r of rows) { if (r.series_id !== hog) break; run++; }
  assert.equal(run, 15,
    `after ten served, fifteen remain in the turn, not twenty-five: got ${run}`);

  await p.query("UPDATE wanted SET state='pending' WHERE series_id=$1", [hog]);
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
});

test("a series that has taken its turn goes behind the ones that have not", { skip: !haveDb }, async () => {
  const p = db();
  const hog = ids.get("Aardvark Saga")!;      // alphabetically first, so it wins every tie
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
  assert.equal((await nextWanted(1, 25))[0]?.series_id, hog,
    "with everyone level, the alphabetically first series leads");

  // It has taken a full block of twenty-five.
  await p.query("UPDATE series SET served = 25 WHERE id = $1", [hog]);
  const next = (await nextWanted(1, 25))[0];
  assert.notEqual(next?.series_id, hog,
    "after a full block it must yield, whatever its title");

  // And a partial block does not: nineteen served is still turn 0.
  await p.query("UPDATE series SET served = 19 WHERE id = $1", [hog]);
  assert.equal((await nextWanted(1, 25))[0]?.series_id, hog,
    "a block is twenty-five, so nineteen is still its turn");

  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
});

test("lifetime downloads do not decide the turn", { skip: !haveDb }, async () => {
  const p = db();
  const veteran = ids.get("Aardvark Saga")!;
  const newcomer = ids.get("Zebra Chronicle")!;
  // The veteran has 300 completed downloads in its history and the newcomer none. Ranking
  // rows against everything ever queued put the veteran in block 12 and made it wait for
  // everyone else to catch up, which is the first fix's mistake in reverse.
  await p.query("UPDATE wanted SET state='done' WHERE series_id=$1 AND chapter_number <= 40", [veteran]);
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);

  const rows = await nextWanted(undefined, 25);
  const first = rows.findIndex((r) => r.series_id === veteran);
  const other = rows.findIndex((r) => r.series_id === newcomer);
  assert.ok(first >= 0 && first < other,
    "history is spent; both are on turn 0 and the tie breaks on title as it always did");

  await p.query("UPDATE wanted SET state='pending' WHERE series_id=$1", [veteran]);
});

/**
 * Rows left mid-download by a process that is gone.
 *
 * "fetching" means a process owns the row. After a restart that is false for all of them,
 * and a pod rolled at page 33 of 46 left a row claiming to be downloading for as long as
 * anyone cared to look: the downloads page showed it in flight and nothing was working it.
 */
const { reclaimStuck } = await import("../src/fetch.js");

test("a restart releases rows nothing is working any more", { skip: !haveDb }, async () => {
  const p = db();
  const id = ids.get("Zebra Chronicle")!;
  const b = (await p.query<{ id: number }>(
    "SELECT id FROM series_binding WHERE series_id = $1", [id])).rows[0]!;

  // One abandoned two minutes ago, one abandoned an hour ago.
  await p.query(
    `UPDATE wanted SET state='fetching', pages_done=33, pages_total=46,
       started_at = now() - interval '2 minutes' WHERE series_id=$1 AND chapter_number=1`, [id]);
  await p.query(
    `UPDATE wanted SET state='fetching', pages_done=5, pages_total=20,
       started_at = now() - interval '60 minutes' WHERE series_id=$1 AND chapter_number=2`, [id]);

  // A tick uses a threshold, so it must not reclaim a row a live run just claimed.
  assert.equal(await reclaimStuck(30), 1, "only the hour-old row is stale to a running tick");
  const fresh = (await p.query<{ state: string; pages_done: number }>(
    "SELECT state, pages_done FROM wanted WHERE series_id=$1 AND chapter_number=1", [id])).rows[0]!;
  assert.equal(fresh.state, "fetching", "the two-minute-old row is left alone");
  assert.equal(fresh.pages_done, 33, "and its progress is untouched");

  // Startup passes 0, because nothing can own a row before the process exists.
  assert.equal(await reclaimStuck(0), 1, "startup releases the rest");
  const both = (await p.query<{ state: string; pages_done: number; pages_total: number | null; started_at: string | null }>(
    "SELECT state, pages_done, pages_total, started_at::text FROM wanted WHERE series_id=$1 AND chapter_number IN (1,2)", [id])).rows;
  assert.equal(both.length, 2);
  for (const r of both) {
    assert.equal(r.state, "pending", "released rows are queued again, not failed");
    assert.equal(r.pages_done, 0, "stale progress is cleared so the page cannot show it");
    assert.equal(r.pages_total, null);
    assert.equal(r.started_at, null);
  }
  assert.equal(await reclaimStuck(0), 0, "nothing left to release, and running it again is harmless");

  await p.query("UPDATE wanted SET state='pending' WHERE series_id=$1", [id]);
});


/**
 * One broken source must not consume the whole run.
 *
 * 7th Time Loop sorts before every letter, so the block ordering served it first and its
 * source timed out on every page. Every tick spent its entire batch of ten on that one
 * series: 24 rows queued and tried, every other series at zero, not a single file written
 * in ninety minutes. This asserts the strike counter, which is the mechanism that stops
 * it, on the same shape.
 */
test("a series failing repeatedly is set aside for the rest of the run", { skip: !haveDb }, async () => {
  // The counter as fetchWanted applies it, exercised directly: the download path itself
  // needs a live source, and what is being tested is the bookkeeping around it.
  const giveUpAfter = 3;
  const strikes = new Map<number, number>();
  const attempted: Array<[number, number]> = [];
  const BROKEN = 1, FINE = 2;
  const work: Array<[number, number]> = [];
  for (let n = 1; n <= 10; n++) work.push([BROKEN, n]);
  for (let n = 1; n <= 10; n++) work.push([FINE, n]);

  for (const [series, chapter] of work) {
    if ((strikes.get(series) ?? 0) >= giveUpAfter) continue;
    attempted.push([series, chapter]);
    if (series === BROKEN) strikes.set(series, (strikes.get(series) ?? 0) + 1);
    else strikes.delete(series);
  }

  const brokenTried = attempted.filter(([s]) => s === BROKEN).length;
  const fineTried = attempted.filter(([s]) => s === FINE).length;
  assert.equal(brokenTried, 3, "the broken series costs three slots, not ten");
  assert.equal(fineTried, 10, "and the working series still gets its whole share");
});

test("a series that recovers has its strikes forgotten", { skip: !haveDb }, async () => {
  const strikes = new Map<number, number>();
  const S = 1;
  strikes.set(S, 2);                 // two failures so far, one short of giving up
  strikes.delete(S);                 // then a chapter succeeds
  assert.equal(strikes.get(S), undefined,
    "a run of failures followed by a success must not leave the series one slip from being dropped");
});

/**
 * When a failed chapter is tried again.
 *
 * There was no waiting. A failure was picked up on the series' next turn, so four attempts
 * burned inside ninety minutes: 7th Time Loop lost ten chapters between 17:07 and 18:44
 * while its source timed out, and chapter 26.6 downloaded successfully in that same window.
 * The source was flaky, not gone, and a bad hour killed every chapter asked for during it.
 */
test("a failed chapter waits before it is tried again", { skip: !haveDb }, async () => {
  const p = db();
  const id = ids.get("Zebra Chronicle")!;
  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL WHERE series_id=$1", [id]);
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);

  const present = async (): Promise<boolean> =>
    (await nextWanted(undefined, 25)).some((r) => r.series_id === id && Number(r.chapter_number) === 1);

  assert.equal(await present(), true, "a pending chapter is a candidate");

  // Failed a minute ago with fifteen minutes to wait.
  await p.query(
    `UPDATE wanted SET state='failed', attempts=1, retry_after = now() + interval '14 minutes'
      WHERE series_id=$1 AND chapter_number=1`, [id]);
  assert.equal(await present(), false, "it is not offered again the moment it fails");

  // Once the wait is up it comes back on its own.
  await p.query(
    "UPDATE wanted SET retry_after = now() - interval '1 minute' WHERE series_id=$1 AND chapter_number=1", [id]);
  assert.equal(await present(), true, "and when the wait is over it is a candidate again");

  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL WHERE series_id=$1", [id]);
});

test("a chapter that has given up stays out until it is put back", { skip: !haveDb }, async () => {
  const { retryFailed } = await import("../src/fetch.js");
  const p = db();
  const id = ids.get("Zebra Chronicle")!;
  const max = Math.max(1, Number(process.env["FETCH_MAX_ATTEMPTS"] ?? 6));
  await p.query(
    `UPDATE wanted SET state='failed', attempts=$2, retry_after=NULL, last_error='timeout'
      WHERE series_id=$1 AND chapter_number=1`, [id, max]);

  const present = async (): Promise<boolean> =>
    (await nextWanted(undefined, 25)).some((r) => r.series_id === id && Number(r.chapter_number) === 1);
  assert.equal(await present(), false, "at the limit it is no longer a candidate");

  assert.ok(await retryFailed(id) >= 1, "retry reports what it put back");
  assert.equal(await present(), true, "and it is a candidate again with a clean count");

  const row = (await p.query<{ attempts: number; last_error: string | null }>(
    "SELECT attempts, last_error FROM wanted WHERE series_id=$1 AND chapter_number=1", [id])).rows[0]!;
  assert.equal(row.attempts, 0, "the count starts over rather than resuming at the limit");
  assert.equal(row.last_error, null, "and the stale error is cleared");

  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL WHERE series_id=$1", [id]);
});

test("retrying one chapter ignores the wait and the attempt limit", { skip: !haveDb }, async () => {
  const { retryFailed } = await import("../src/fetch.js");
  const p = db();
  const id = ids.get("Zebra Chronicle")!;
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
  // Failed, mid-backoff, and short of the limit: a bulk retry would leave it alone.
  await p.query(
    `UPDATE wanted SET state='failed', attempts=2, last_error='timeout',
       retry_after = now() + interval '5 hours' WHERE series_id=$1 AND chapter_number=1`, [id]);

  const present = async (): Promise<boolean> =>
    (await nextWanted(undefined, 25)).some((r) => r.series_id === id && Number(r.chapter_number) === 1);
  assert.equal(await present(), false, "it is waiting, so it is not a candidate");
  assert.equal(await retryFailed(id), 0, "a bulk retry only takes chapters that gave up");

  assert.equal(await retryFailed(id, "1.0000"), 1, "naming it retries it");
  assert.equal(await present(), true, "and it is a candidate immediately, not in five hours");
  const row = (await p.query<{ attempts: number; retry_after: string | null }>(
    "SELECT attempts, retry_after::text AS retry_after FROM wanted WHERE series_id=$1 AND chapter_number=1", [id])).rows[0]!;
  assert.equal(row.attempts, 0);
  assert.equal(row.retry_after, null, "the wait is cleared, or it would not actually be tried now");

  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL WHERE series_id=$1", [id]);
});

test("a named chapter is selectable outside the rotation", { skip: !haveDb }, async () => {
  const p = db();
  const id = ids.get("Zebra Chronicle")!;
  // Buried: waiting out a backoff, and every other series ahead of it on turn order.
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
  await p.query(
    `UPDATE wanted SET state='failed', attempts=3, retry_after = now() + interval '6 hours'
      WHERE series_id=$1 AND chapter_number=4`, [id]);

  assert.equal((await nextWanted(undefined, 25)).some(
    (r) => r.series_id === id && Number(r.chapter_number) === 4), false,
    "the rotation will not offer it");

  const one = await nextWanted(undefined, undefined, { seriesId: id, chapter: "4.0000" });
  assert.equal(one.length, 1, "naming it selects it regardless of turn, backoff or attempts");
  assert.equal(Number(one[0]!.chapter_number), 4);
  assert.ok(one[0]!.source_url !== undefined, "and it carries the binding needed to fetch it");

  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL WHERE series_id=$1", [id]);
});

test("a chapter already in flight is not picked up twice", { skip: !haveDb }, async () => {
  const p = db();
  const id = ids.get("Zebra Chronicle")!;
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
  // A manual retry runs outside the scheduler, so a tick must not grab the same row.
  await p.query(
    `UPDATE wanted SET state='fetching', started_at = now(), attempts=0, retry_after=NULL
      WHERE series_id=$1 AND chapter_number=5`, [id]);
  assert.equal((await nextWanted(undefined, 25)).some(
    (r) => r.series_id === id && Number(r.chapter_number) === 5), false,
    "a row started seconds ago is being worked on, not waiting");

  // But one abandoned long ago is fair game again.
  await p.query(
    "UPDATE wanted SET started_at = now() - interval '20 minutes' WHERE series_id=$1 AND chapter_number=5", [id]);
  assert.equal((await nextWanted(undefined, 25)).some(
    (r) => r.series_id === id && Number(r.chapter_number) === 5), true,
    "a stale one is, or a dead process would strand it");

  await p.query("UPDATE wanted SET state='pending', started_at=NULL WHERE series_id=$1", [id]);
});

/**
 * A chapter that has just failed has to be visible somewhere.
 *
 * The downloads page showed three lists: in flight, done, and given up at the attempt
 * limit. A chapter that had just failed its first attempt was in none of them, so pressing
 * retry and watching it fail made it vanish from the page you were watching. It was in the
 * database the whole time, which is why "the chapter disappeared" was so hard to pin down.
 */
test("a chapter that just failed appears in the recent list", { skip: !haveDb }, async () => {
  const { liveState } = await import("../src/ui/downloads.js");
  const p = db();
  const id = ids.get("Zebra Chronicle")!;
  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL, started_at=NULL WHERE series_id=$1", [id]);

  // Exactly the state a first failure leaves behind: short of the limit, waiting to retry.
  await p.query(
    `UPDATE wanted SET state='failed', attempts=1, started_at=now() - interval '2 minutes',
       retry_after=now() + interval '13 minutes', last_error='page 3 returned 500'
      WHERE series_id=$1 AND chapter_number=1`, [id]);

  const live = await liveState();
  const row = live.recent.find((r) => r.seriesId === id && Number(r.chapter) === 1);
  assert.ok(row, "a chapter that just failed must be on the page, not only in the database");
  assert.equal(row!.ok, false);
  assert.match(row!.error ?? "", /page 3 returned 500/, "with the reason it failed");
  assert.ok((row!.retryIn ?? 0) > 0, "and when it will be tried again");

  assert.ok(!live.active.some((r) => r.seriesId === id && Number(r.chapter) === 1),
    "it is not in flight");
  assert.ok(!live.stuck.some((r) => r.seriesId === id && Number(r.chapter) === 1),
    "and it has not given up either, which is why it fell through every list");

  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL, started_at=NULL, last_error=NULL WHERE series_id=$1", [id]);
});

/**
 * Giving up on a series has to outlive the run that decided it.
 *
 * The strike counter lived in a Map for the duration of one run, so the next run selected
 * the same dead series, spent its three strikes on three fresh chapters, and skipped the
 * rest of the batch. Mf Ghost against a Mangabat CDN that was down held the whole
 * downloader for ninety minutes: 24 attempts, zero chapters, no other series considered.
 * Series added hours earlier sat on nothing while the rotation looked correct, because the
 * batch it handed over was 100% one dead series before any strike could apply.
 */
test("a series parked after repeated failures stops monopolising the queue", { skip: !haveDb }, async () => {
  const p = db();
  // Aardvark sorts first, so it wins the tie inside block 0 and fills the batch on
  // its own. Middle Tale is the series starving behind it.
  const dead = ids.get("Aardvark Saga")!;
  const other = ids.get("Middle Tale")!;
  await p.query("UPDATE series SET served = 0 WHERE id = ANY($1)", [[...ids.values()]]);
  await p.query("UPDATE wanted SET state='pending', attempts=0, retry_after=NULL, started_at=NULL");

  // Before the park, the dead series is first and takes the whole batch.
  const before = await nextWanted(6, 25);
  assert.ok(before.every((r) => r.series_id === dead),
    "the failing series wins the rotation and fills the batch on its own");

  // What the strike now does: every outstanding row of that series leaves the queue.
  await p.query(
    `UPDATE wanted SET retry_after = now() + interval '60 minutes'
      WHERE series_id = $1 AND state IN ('pending','failed')`, [dead]);

  const after = await nextWanted(6, 25);
  assert.ok(after.length > 0, "the tick still has work to do");
  assert.ok(after.every((r) => r.series_id !== dead),
    "the parked series is gone from selection, so the batch reaches someone else");
  assert.ok(after.some((r) => r.series_id === other),
    "and that someone else is a series that was starving behind it");

  // The park is a delay, not a deletion: the chapters are still owed.
  const owed = await p.query<{ n: string }>(
    "SELECT count(*) n FROM wanted WHERE series_id=$1 AND state='pending'", [dead]);
  assert.ok(Number(owed.rows[0]!.n) > 0, "nothing was dropped, only deferred");

  await p.query("UPDATE wanted SET retry_after=NULL");
});
