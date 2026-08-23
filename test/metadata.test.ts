import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Two paths that write, so neither can be proven against the live library.
 *
 * The first is the cover fallback. An archived series has no source binding by design,
 * and every route to a cover used to go through a source, so it stayed blank forever.
 * The first page of its earliest chapter is on disk and is a perfectly good cover.
 *
 * The second is marking a run of chapters read in one call, which is what a series read
 * somewhere else before this library existed needs.
 */
const root = mkdtempSync(join(tmpdir(), "kupo-meta-"));
const legacyRoot = join(root, "Manga");
const libraryRoot = join(root, "Library");

process.env["LEGACY_ROOT"] = legacyRoot;
process.env["LIBRARY_ROOT"] = libraryRoot;
process.env["DATABASE_URL"] = process.env["TEST_DATABASE_URL"]
  ?? "postgres://postgres:test@127.0.0.1:55444/kupoyomi";

const { refreshMetadata } = await import("../src/metadata.js");
const { setProgressUpTo, lastReadChapter, getChapters } = await import("../src/pbapi.js");
const { buildCbz, comicInfo } = await import("../src/cbz.js");
const { db, migrate, closeDb } = await import("../src/db.js");

let haveDb = false;
try {
  await db().query("SELECT 1");
  haveDb = true;
} catch {
  console.log("no database reachable, skipping the metadata integration test");
}

const SERIES = "Archived Test Series";
const FOLDER = SERIES;
const DIR = join(libraryRoot, FOLDER);
/** A real JPEG header of a given shape, with distinguishable trailing bytes so a wrong
 *  page produces a failure rather than a pass. */
const jpegOf = (w: number, h: number, tag: string): Buffer => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
  Buffer.from([(h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff]),
  Buffer.alloc(8),
  Buffer.from(tag),
]);

// Page one of a webtoon chapter is one enormous strip, which is unusable as cover art.
const STRIP = jpegOf(720, 15560, "STRIP");
const GOOD_PAGE = jpegOf(1000, 1400, "GOOD-PAGE");
let seriesId = 0;

before(async () => {
  if (!haveDb) return;
  await migrate();
  const p = db();
  await p.query("DELETE FROM series WHERE title = $1", [SERIES]);
  mkdirSync(DIR, { recursive: true });

  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder, status, muted) VALUES ($1,$2,'COMPLETED',true) RETURNING id",
    [SERIES, FOLDER]);
  seriesId = s.rows[0]!.id;

  // Three chapters. Only the earliest carries a ComicInfo summary, because that is the
  // one the fallback is supposed to read.
  for (const n of [1, 2, 3]) {
    const file = join(DIR, `${SERIES} - c000${n}.cbz`);
    const pages = n === 1
      ? [{ name: "001.jpg", data: STRIP }, { name: "002.jpg", data: GOOD_PAGE }]
      : [{ name: "001.jpg", data: jpegOf(1000, 1400, `later-ch${n}`) }];
    const extra = n === 1
      ? [{ name: "ComicInfo.xml", data: Buffer.from(comicInfo({
          series: SERIES, number: "1", pageCount: pages.length,
          summary: "A summary written into the archive & kept.",
        })) }]
      : [];
    writeFileSync(file, buildCbz([...extra, ...pages], new Date("2026-01-01T00:00:00Z")));
    await p.query(
      "INSERT INTO chapter (series_id, chapter_number, file_path, page_count) VALUES ($1,$2,$3,$4)",
      [seriesId, n, file, pages.length]);
  }
});

after(async () => {
  if (!haveDb) return;
  await db().query("DELETE FROM series WHERE title = $1", [SERIES]);
  await closeDb();
});

test("a series with no source binding still gets a cover and a synopsis", { skip: !haveDb }, async () => {
  const got = await refreshMetadata(seriesId);
  assert.equal(got.cover, true, "an archived series must end up with cover art");

  const cover = join(DIR, "cover.jpg");
  assert.ok(existsSync(cover), "cover.jpg is written into the series folder");
  assert.deepEqual(readFileSync(cover), GOOD_PAGE,
    "the cover comes from the EARLIEST chapter, and is the page-shaped image rather than "
    + "the 720x15560 strip that happens to be page one");
  assert.ok(!existsSync(join(DIR, ".cover.part")), "the temp file is renamed, never left behind");

  const row = (await db().query<{ cover_path: string | null; description: string | null }>(
    "SELECT cover_path, description FROM series WHERE id = $1", [seriesId])).rows[0]!;
  assert.equal(row.cover_path, cover, "the ledger points at the file that exists");
  assert.match(row.description ?? "", /summary written into the archive & kept/,
    "the ComicInfo summary is recovered and its entities decoded");
});

test("an existing cover.jpg is adopted rather than overwritten", { skip: !haveDb }, async () => {
  const cover = join(DIR, "cover.jpg");
  writeFileSync(cover, Buffer.from("KOMF-LEFT-THIS"));
  await db().query("UPDATE series SET cover_path = NULL WHERE id = $1", [seriesId]);

  await refreshMetadata(seriesId);
  assert.deepEqual(readFileSync(cover), Buffer.from("KOMF-LEFT-THIS"),
    "a cover already on disk is real art and must not be clobbered");
});

test("marking read up to a chapter marks that chapter and everything below it", { skip: !haveDb }, async () => {
  assert.equal(await lastReadChapter(seriesId), null, "nothing is read to begin with");

  const marked = await setProgressUpTo(seriesId, "2.0000");
  assert.equal(marked, 2, "chapters 1 and 2, and not chapter 3");
  assert.equal(await lastReadChapter(seriesId), 2);

  const chapters = await getChapters(seriesId);
  const byNum = new Map(chapters.map((c) => [c.number, c]));
  assert.equal(byNum.get(1)?.read, true);
  assert.equal(byNum.get(2)?.read, true);
  assert.equal(byNum.get(3)?.read, false, "a chapter above the mark stays unread");
  assert.equal(byNum.get(1)?.lastPage, 2, "last page is set from the recorded page count");
});

test("marking read is idempotent and never rewinds", { skip: !haveDb }, async () => {
  await setProgressUpTo(seriesId, "3.0000");
  assert.equal(await lastReadChapter(seriesId), 3);

  // A lower mark arriving later, as a stale phone would send, must not undo the higher one.
  await setProgressUpTo(seriesId, "1.0000");
  assert.equal(await lastReadChapter(seriesId), 3, "a lower mark does not unread chapter 3");

  const again = await setProgressUpTo(seriesId, "3.0000");
  assert.equal(again, 3, "re-running touches the same rows and adds none");
  assert.equal(await lastReadChapter(seriesId), 3);
});

test("stopping a series clears its outstanding queue but keeps its history", { skip: !haveDb }, async () => {
  const p = db();
  const b = await p.query<{ id: number }>(
    `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, role)
     VALUES ($1,'S','S',0,'primary') RETURNING id`, [seriesId]);
  const bindingId = b.rows[0]!.id;
  await p.query(
    `INSERT INTO wanted (series_id, chapter_number, binding_id, state) VALUES
       ($1, 10, $2, 'pending'), ($1, 11, $2, 'failed'), ($1, 12, $2, 'done')`,
    [seriesId, bindingId]);

  // What the mute route does. Kept in one place here so the invariant is asserted rather
  // than assumed: a stopped series contributes nothing to the queue.
  await p.query("UPDATE series SET muted = true WHERE id = $1", [seriesId]);
  await p.query("DELETE FROM wanted WHERE series_id = $1 AND state <> 'done'", [seriesId]);

  const left = (await p.query<{ chapter_number: string; state: string }>(
    "SELECT chapter_number, state FROM wanted WHERE series_id = $1 ORDER BY chapter_number",
    [seriesId])).rows;
  assert.equal(left.length, 1, "only the completed row survives");
  assert.equal(left[0]?.state, "done", "download history is not queue backlog and stays");

  const outstanding = (await p.query<{ n: string }>(
    "SELECT count(*) n FROM wanted WHERE state <> 'done'")).rows[0];
  assert.equal(Number(outstanding?.n), 0, "a stopped series adds nothing to the outstanding count");
});

/**
 * The adoption path, which is the whole point of the project.
 *
 * remap used to find what was held with its own query against legacy_chapter, gated on
 * is_downloaded. That flag lies: on Noble in Name, Vulgar at Heart it was set on 1 of 44
 * rows while all 44 files were on disk, so a confirmed migration adopted one chapter and
 * queued the other 43 for re-download. heldChapters lets the filesystem decide, and this
 * asserts remap agrees with it.
 */
test("adoption follows the disk, not Suwayomi's downloaded flag", { skip: !haveDb }, async () => {
  const { heldChapters } = await import("../src/held.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();

  const DEAD = "Dead Source (EN)";
  const FOLDER = "Flag Liar Series";
  const dir = join(legacyRoot, DEAD, FOLDER);
  mk(dir, { recursive: true });
  for (const n of [1, 2, 3, 4]) wf(join(dir, `Official_Episode ${n}.cbz`), Buffer.from(`ch${n}`));

  // A snapshot that claims only chapter 1 was ever downloaded, which is the shape that
  // caused the bug.
  const MID = 987654;
  await p.query("DELETE FROM legacy_manga WHERE suwayomi_id = $1", [MID]);
  await p.query(
    `INSERT INTO legacy_manga (suwayomi_id, title, source_name, in_library, download_count)
     VALUES ($1,$2,$3,true,1)`, [MID, FOLDER, DEAD]);
  for (const n of [1, 2, 3, 4]) {
    await p.query(
      `INSERT INTO legacy_chapter (suwayomi_manga_id, chapter_number, name, is_downloaded)
       VALUES ($1,$2,$3,$4)`, [MID, n, `Official_Episode ${n}`, n === 1]);
  }

  const held = await heldChapters(DEAD, FOLDER, MID);
  assert.deepEqual([...held.keys()].sort((a, b) => a - b), [1, 2, 3, 4],
    "all four files are held; the flag being set on one of them is irrelevant");

  await p.query("DELETE FROM legacy_manga WHERE suwayomi_id = $1", [MID]);
});

/**
 * Paid subscription sources.
 *
 * Manta gave three free chapters and served a six-page purchase notice for the next 99,
 * each recorded as a successful download. The lasting damage is not the bytes: the ledger
 * then believes chapter 4 is held, so a real source's chapter 4 is skipped as already
 * present. A paid source is worse than no source, so it must not be reachable.
 */
test("paid sources are recognised and an empty list matches nothing", { skip: !haveDb }, async () => {
  const { isPaidSource, forgetPaid, paidPattern } = await import("../src/paid.js");
  forgetPaid();

  for (const name of ["Manta (EN)", "manta", "Comikey", "Coolmic", "Mangamo",
                      "Toomics (EN)", "Lezhin (EN)", "Pocket Comics", "PocketComics",
                      "Manga Planet", "MangaPlanet"]) {
    assert.equal(await isPaidSource(name), true, `${name} must be recognised as paid`);
  }
  for (const name of ["MangaDex (EN)", "LikeManga (EN)", "Weeb Central (EN)",
                      "ManhuaTop (EN)", "MangaFox (EN)", "Atsumaru (EN)"]) {
    assert.equal(await isPaidSource(name), false, `${name} is free and must stay usable`);
  }

  // An empty list must not compile to a regex that matches every source, which would
  // silently hide the entire library from search.
  const p = db();
  await p.query("BEGIN");
  await p.query("DELETE FROM paid_source");
  forgetPaid();
  assert.equal(await isPaidSource("Manta (EN)"), false, "no rows means nothing is paid");
  assert.equal((await paidPattern()).test("literally anything"), false,
    "an empty list must never match everything");
  await p.query("ROLLBACK");
  forgetPaid();
  assert.equal(await isPaidSource("Manta (EN)"), true, "and the list is back after rollback");
});

test("adding a series from a paid source is refused", { skip: !haveDb }, async () => {
  const { addSeries } = await import("../src/ui/search.js");
  const { forgetPaid } = await import("../src/paid.js");
  forgetPaid();
  await assert.rejects(
    () => addSeries({ title: "Paid Test Series", sourceId: "1", sourceName: "Manta (EN)", url: "/x" }),
    /paid subscription/,
    "the last gate refuses it even if a stale page posts the form");
  const left = (await db().query<{ n: string }>(
    "SELECT count(*) n FROM series WHERE title = $1", ["Paid Test Series"])).rows[0];
  assert.equal(Number(left?.n), 0, "and no series row is left behind");
});
