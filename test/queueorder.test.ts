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

test("every series gets its first block before any gets its second", { skip: !haveDb }, async () => {
  const rows = await nextWanted(undefined, 25);
  const mine = rows.filter((r) => ids.has(r.title));
  assert.equal(mine.length, 110, "all three backlogs are present");

  // Where each series' second block begins, against where the last first block ends.
  const seen = new Map<string, number>();
  const firstBlockEnd = new Map<string, number>();
  const secondBlockStart = new Map<string, number>();
  mine.forEach((r, i) => {
    const n = (seen.get(r.title) ?? 0) + 1;
    seen.set(r.title, n);
    if (n <= 25) firstBlockEnd.set(r.title, i);
    if (n === 26) secondBlockStart.set(r.title, i);
  });

  const lastFirstBlock = Math.max(...[...firstBlockEnd.values()]);
  for (const [title, at] of secondBlockStart) {
    assert.ok(at > lastFirstBlock,
      `${title} started its second block at ${at}, before every series finished a first block at ${lastFirstBlock}`);
  }

  // Zebra has 10 chapters, so its whole backlog is block 0 and it must be served early.
  const zebraLast = mine.map((r, i) => [r.title, i] as const)
    .filter(([t]) => t === "Zebra Chronicle").at(-1)![1];
  assert.ok(zebraLast < 75,
    `the smallest series finished at position ${zebraLast}; under title ordering it would be last`);
});

test("a block size of one interleaves every series chapter by chapter", { skip: !haveDb }, async () => {
  const rows = (await nextWanted(6, 1)).filter((r) => ids.has(r.title));
  assert.deepEqual(rows.map((r) => r.title), [
    "Aardvark Saga", "Middle Tale", "Zebra Chronicle",
    "Aardvark Saga", "Middle Tale", "Zebra Chronicle",
  ], "block size 1 is strict round robin, which proves the block maths");
});

test("a tick stays inside one series' block rather than hopping sources", { skip: !haveDb }, async () => {
  const rows = (await nextWanted(10, 25)).filter((r) => ids.has(r.title));
  assert.equal(rows.length, 10);
  assert.equal(new Set(rows.map((r) => r.title)).size, 1,
    "within one block the batch stays on one series, so the downloader is not hopping sources");
  assert.equal(rows[0]?.title, "Aardvark Saga");
});

/**
 * The gap range's ceiling.
 *
 * A series holding 1-8 and then 12.3 reported no gaps at all: the highest WHOLE chapter
 * was 8, so the range stopped there and 9 through 12 were invisible. Holding 12.3 is
 * proof those exist, and a run of missing chapters reaching your top chapter is a source
 * that stopped partway, which is the one case worth flagging.
 */
const { findGaps } = await import("../src/gaps.js");
const GAPSERIES = "Gap Ceiling Series";
let gapId = 0;

test("a decimal top chapter does not truncate the gap range", { skip: !haveDb }, async () => {
  const p = db();
  await p.query("DELETE FROM series WHERE title = $1", [GAPSERIES]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [GAPSERIES]);
  gapId = s.rows[0]!.id;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 12.3]) {
    await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,$3)",
      [gapId, n, `/nowhere/${n}.cbz`]);
  }

  const g = await findGaps(gapId);
  assert.deepEqual(g.missing, [9, 10, 11, 12],
    "9 through 12 are missing; holding 12.3 is what proves they exist");
  assert.deepEqual(g.unsupplied, [9, 10, 11, 12], "none of them are queued");

  await p.query("DELETE FROM series WHERE id = $1", [gapId]);
});

test("a decimal inside the range is still not treated as a gap", { skip: !haveDb }, async () => {
  const p = db();
  await p.query("DELETE FROM series WHERE title = $1", [GAPSERIES]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [GAPSERIES]);
  const id = s.rows[0]!.id;
  // 12.1 and 12.2 are one site's split of chapter 12. A missing 12.2 is not a hole.
  for (const n of [1, 2, 3, 12, 12.1]) {
    await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,$3)",
      [id, n, `/nowhere/${n}.cbz`]);
  }
  const g = await findGaps(id);
  assert.deepEqual(g.missing, [4, 5, 6, 7, 8, 9, 10, 11],
    "whole chapters only, and 12.2 is not invented as missing");
  await p.query("DELETE FROM series WHERE id = $1", [id]);
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
