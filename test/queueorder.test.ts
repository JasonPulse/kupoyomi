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
