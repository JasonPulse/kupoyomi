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

/**
 * Adding a source to a work already in the library.
 *
 * The search card groups every listing of one work together and badges it "in library",
 * but the add form used to post only the source's title. canonical() keeps case and
 * brackets, so "Kill The Villainess" and "Kill the Villainess (Comic)" each produced a
 * folder of their own and each became a SECOND series for a work already held. That is
 * how To You, Noble and Vulgar ended up beside Noble in Name, Vulgar at Heart, one
 * holding 1-44 and the other 45-50, each queued to download what the other had.
 */
test("a source added to a series in the library attaches instead of duplicating", { skip: !haveDb }, async () => {
  const { addSeries } = await import("../src/ui/search.js");
  const p = db();
  const TITLE = "Attach Test Series";
  await p.query("DELETE FROM series WHERE title ILIKE $1 OR folder ILIKE $1", [`${TITLE}%`]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const id = s.rows[0]!.id;
  await p.query(
    `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, role)
     VALUES ($1,'a','First Source',0,'primary')`, [id]);

  // The three shapes that each used to create their own series.
  for (const [i, variant] of ["ATTACH TEST SERIES", `${TITLE} (Comic)`, `${TITLE} [Official]`].entries()) {
    const got = await addSeries({
      title: variant, sourceId: `s${i}`, sourceName: `Source ${i}`, url: `/u${i}`, seriesId: id,
    });
    assert.equal(got, id, `${variant} must attach to the series it was chosen for`);
  }

  const count = (await p.query<{ n: string }>(
    "SELECT count(*) n FROM series WHERE folder ILIKE $1", [`${TITLE}%`])).rows[0];
  assert.equal(Number(count?.n), 1, "still exactly one series, not four");

  const roles = (await p.query<{ role: string; source_name: string }>(
    "SELECT role, source_name FROM series_binding WHERE series_id = $1 ORDER BY source_name", [id])).rows;
  assert.equal(roles.length, 4, "one primary and three supplemental");
  assert.equal(roles.filter((r) => r.role === "primary").length, 1,
    "the incumbent stays primary: attaching a source must not silently switch the binding");

  await p.query("DELETE FROM series WHERE id = $1", [id]);
});

test("without a series id, a title differing only in case still attaches", { skip: !haveDb }, async () => {
  const { addSeries } = await import("../src/ui/search.js");
  const p = db();
  const TITLE = "Case Fallback Series";
  await p.query("DELETE FROM series WHERE folder ILIKE $1", [`${TITLE}%`]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const id = s.rows[0]!.id;

  // Browse has no series id to pass, so the folder match is the only defence there.
  const got = await addSeries({
    title: "CASE fallback SERIES", sourceId: "z", sourceName: "Some Source", url: "/z",
  });
  assert.equal(got, id, "a capital letter is not a different work");

  const count = (await p.query<{ n: string }>(
    "SELECT count(*) n FROM series WHERE folder ILIKE $1", [`${TITLE}%`])).rows[0];
  assert.equal(Number(count?.n), 1);
  await p.query("DELETE FROM series WHERE id = $1", [id]);
});

/**
 * Linking a folder on disk to a series.
 *
 * Adoption used to read one import_candidate folder per series, so 7th Time Loop's
 * hand-made second folder was invisible and its chapters 1, 5.5 and 21.5 went back on the
 * download queue while sitting on disk. Eleven more such folders exist. Name similarity
 * can propose a link but must not decide one, because "Kusuriya_no_Hitorigoto" and "The
 * Apothecary Diaries" are the same work and share no letters.
 */
test("adoption acts on a linked folder and never on a guess", { skip: !haveDb }, async () => {
  const { findOnDisk, adoptFromDisk, setLink } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const TITLE = "Linkable Test Series";
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const sid = s.rows[0]!.id;

  // A hand-made folder, underscores and all, holding chapters the series does not have.
  const legacy = join(legacyRoot, "Linkable_Test_Series");
  mk(legacy, { recursive: true });
  for (const n of [1, 2, "2.5"]) wf(join(legacy, `Chapter ${n}.cbz`), Buffer.from(`ch${n}`));

  // A guess is visible only when asked for, and adoption refuses to act on it.
  assert.equal((await findOnDisk(sid)).sources.length, 0, "nothing is linked yet");
  const proposed = await findOnDisk(sid, { propose: true });
  assert.equal(proposed.sources.length, 1, "the name match is offered as a proposal");
  assert.equal(proposed.sources[0]?.linked, false, "and it is marked as a guess");
  assert.equal(await adoptFromDisk(sid, { propose: true }), 0,
    "a proposal must never be adopted: confirming it is the whole point");

  await setLink(sid, legacy, "linked");
  const adopted = await adoptFromDisk(sid);
  assert.equal(adopted, 3, "once linked, all three chapters are adopted");
  const held = (await p.query<{ n: string }>(
    "SELECT chapter_number AS n FROM chapter WHERE series_id = $1 ORDER BY chapter_number", [sid])).rows;
  assert.deepEqual(held.map((r) => Number(r.n)), [1, 2, 2.5], "decimals included");

  // Adopting twice must not double anything, and the legacy files must survive.
  assert.equal(await adoptFromDisk(sid), 0, "nothing left to adopt, and running it again is harmless");
  assert.ok(existsSync(join(legacy, "Chapter 1.cbz")), "the legacy folder is untouched");

  await setLink(sid, legacy, "ignored");
  assert.equal((await findOnDisk(sid, { propose: true })).sources.length, 0,
    "an ignored folder is never offered again");

  await p.query("DELETE FROM series WHERE id = $1", [sid]);
});

test("a folder linked to one series is not offered to another", { skip: !haveDb }, async () => {
  const { findOnDisk, setLink } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const A = "Shared Folder Series A", B = "Shared Folder Series B";
  for (const t of [A, B]) await p.query("DELETE FROM series WHERE title = $1", [t]);
  const ids: number[] = [];
  for (const t of [A, B]) {
    const r = await p.query<{ id: number }>(
      "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [t]);
    ids.push(r.rows[0]!.id);
  }
  const legacy = join(legacyRoot, "Shared_Folder_Series");
  mk(legacy, { recursive: true });
  wf(join(legacy, "Chapter 1.cbz"), Buffer.from("x"));

  await setLink(ids[0]!, legacy, "linked");
  const forB = await findOnDisk(ids[1]!, { propose: true });
  assert.equal(forB.sources.length, 0,
    "two series adopting one file would give both the same chapter and one the wrong story");

  for (const id of ids) await p.query("DELETE FROM series WHERE id = $1", [id]);
});

/**
 * Other names a series goes by.
 *
 * Half the folders on disk are romanised Japanese and share no letters with their English
 * titles: Kusuriya_no_Hitorigoto is The Apothecary Diaries. No similarity measure will
 * ever connect those, so the fact has to be stated once and remembered.
 */
test("an alias makes a folder match a title it shares no letters with", { skip: !haveDb }, async () => {
  const { addAlias, findOnDisk, adoptFromDisk, setLink, aliasesFor } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const TITLE = "The Apothecary Chronicles Test";
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const sid = s.rows[0]!.id;

  const legacy = join(legacyRoot, "Kusuriya_no_Hitorigoto_Test");
  mk(legacy, { recursive: true });
  for (const n of [1, 2]) wf(join(legacy, `Chapter ${n}.cbz`), Buffer.from(`ch${n}`));

  // Nothing connects the two names, so nothing is proposed.
  assert.equal((await findOnDisk(sid, { propose: true })).sources.length, 0,
    "a romanised folder cannot be matched by similarity, which is the whole problem");

  await addAlias(sid, "Kusuriya no Hitorigoto Test");
  const after = await findOnDisk(sid, { propose: true });
  assert.equal(after.sources.length, 1, "with the name stated, the folder is found");
  assert.equal(after.sources[0]?.linked, false, "and it is still only a proposal");

  await setLink(sid, legacy, "linked");
  assert.equal(await adoptFromDisk(sid), 2);

  // Linking teaches the folder name as an alias, so a second folder named the same way
  // is recognised without being told again.
  const names = (await aliasesFor(sid)).map((a) => a.alias);
  assert.ok(names.some((n) => /Kusuriya no Hitorigoto Test/i.test(n)),
    `linking should record the folder name: got ${JSON.stringify(names)}`);

  await p.query("DELETE FROM series WHERE id = $1", [sid]);
});

test("a linked folder holding nothing new is reported as redundant, and only then deleted", { skip: !haveDb }, async () => {
  const { setLink, adoptFromDisk, redundantFolders } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const TITLE = "Redundant Folder Series";
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const sid = s.rows[0]!.id;

  const legacy = join(legacyRoot, "Redundant_Folder_Series");
  mk(legacy, { recursive: true });
  for (const n of [1, 2, 3]) wf(join(legacy, `Chapter ${n}.cbz`), Buffer.from(`chapter ${n} bytes`));
  await setLink(sid, legacy, "linked");

  // Before adopting, the folder holds chapters the library lacks, so it is not redundant.
  let report = (await redundantFolders()).filter((f) => f.path === legacy);
  assert.equal(report[0]?.heldAll, false, "a folder holding something new must never be deletable");

  await adoptFromDisk(sid);
  report = (await redundantFolders()).filter((f) => f.path === legacy);
  assert.equal(report[0]?.heldAll, true, "once every chapter is held it is a second copy");
  assert.equal(report[0]?.files, 3);
  assert.ok((report[0]?.bytes ?? 0) > 0, "and it reports the space it would free");

  // A single unreadable filename protects the whole folder.
  wf(join(legacy, "bonus material.cbz"), Buffer.from("x"));
  report = (await redundantFolders()).filter((f) => f.path === legacy);
  assert.equal(report[0]?.heldAll, false,
    "a file whose chapter number cannot be read is not proven redundant");

  assert.ok(existsSync(join(legacy, "Chapter 1.cbz")), "nothing was deleted by reporting");
  await p.query("DELETE FROM series WHERE id = $1", [sid]);
});
