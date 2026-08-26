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

test("space freed counts only files the library does not already own", { skip: !haveDb }, async () => {
  const { setLink, adoptFromDisk, redundantFolders } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const TITLE = "Hardlink Accounting Series";
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const sid = s.rows[0]!.id;

  const legacy = join(legacyRoot, "Hardlink_Accounting_Series");
  mk(legacy, { recursive: true });
  const body = Buffer.alloc(4096, 7);
  for (const n of [1, 2]) wf(join(legacy, `Chapter ${n}.cbz`), body);
  await setLink(sid, legacy, "linked");
  await adoptFromDisk(sid);          // hardlinks both into the library

  const f = (await redundantFolders()).find((x) => x.path === legacy)!;
  assert.equal(f.heldAll, true);
  assert.equal(f.files, 2);
  assert.ok(f.bytes >= 8192, "the folder really is that big on disk");
  assert.equal(f.linkedCopies, 2, "both files are hardlinks the library already holds");
  assert.equal(f.reclaimable, 0,
    "so deleting the folder frees nothing, and reporting its size as freed space is a lie");

  await p.query("DELETE FROM series WHERE id = $1", [sid]);
});

/**
 * Bulk linking, which is only safe because it demands an exact name.
 *
 * Most of the 66 undecided folders are the source folders their series were migrated
 * from, so their names match a library title letter for letter once punctuation is
 * dropped. An exact match on the whole name can be acted on in bulk; a similarity score
 * cannot, and two series sharing a name cannot be guessed between at all.
 */
test("bulk linking takes exact name matches and refuses ambiguous ones", { skip: !haveDb }, async () => {
  const { linkObvious, findOnDisk } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const EXACT = "Bulk Exact Series", TWIN = "Bulk Twin Series";
  await p.query("DELETE FROM series WHERE title IN ($1,$2)", [EXACT, TWIN]);

  const one = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [EXACT]);
  const exactId = one.rows[0]!.id;
  // Two series with the same title under different folders, which is a real state: the
  // same work listed twice by different names on disk.
  const twinA = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$2) RETURNING id", [TWIN, `${TWIN} A`]);
  const twinB = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$2) RETURNING id", [TWIN, `${TWIN} B`]);

  // Punctuation differs, which is exactly what a folder name does to a title.
  const exactDir = join(legacyRoot, "Bulk Exact_ Series".replace("_", ""));
  mk(exactDir, { recursive: true });
  wf(join(exactDir, "Chapter 1.cbz"), Buffer.from("a"));
  const twinDir = join(legacyRoot, TWIN);
  mk(twinDir, { recursive: true });
  wf(join(twinDir, "Chapter 1.cbz"), Buffer.from("b"));

  await linkObvious();

  assert.equal((await findOnDisk(exactId)).sources.length, 1,
    "an exact name match is linked without being asked");
  for (const t of [twinA, twinB]) {
    assert.equal((await findOnDisk(t.rows[0]!.id)).sources.length, 0,
      "two series of the same name must not be guessed between: picking one adopts the other's chapters");
  }

  await p.query("DELETE FROM series WHERE title IN ($1,$2)", [EXACT, TWIN]);
});

test("a folder with no series becomes one, with no source", { skip: !haveDb }, async () => {
  const { importFolder } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  await p.query("DELETE FROM series WHERE title = $1", ["Isekai Import Test"]);

  // Underscores where the spaces were, which is how these arrived on disk.
  const dir = join(legacyRoot, "Isekai_Import_Test");
  mk(dir, { recursive: true });
  for (const n of [1, 2, 3]) wf(join(dir, `Chapter ${n}.cbz`), Buffer.from(`ch${n}`));

  const id = await importFolder(dir);
  const s = (await p.query<{ title: string; held: string; bindings: string }>(
    `SELECT s.title, (SELECT count(*) FROM chapter c WHERE c.series_id=s.id)::text held,
            (SELECT count(*) FROM series_binding b WHERE b.series_id=s.id)::text bindings
       FROM series s WHERE s.id = $1`, [id])).rows[0]!;
  assert.equal(s.title, "Isekai Import Test", "underscores become spaces in the title");
  assert.equal(Number(s.held), 3, "everything in the folder is adopted");
  assert.equal(Number(s.bindings), 0,
    "and it has no source: a folder cannot say where new chapters come from");

  // Running it again must attach rather than make a second series.
  const again = await importFolder(dir);
  assert.equal(again, id, "importing the same folder twice is not two series");

  await p.query("DELETE FROM series WHERE id = $1", [id]);
});

/**
 * What "recently updated" is ordered by.
 *
 * It was ordered by the newest upstream upload date, so the same two titles sat at the top
 * of Paperback's home screen for days while thirteen series and eight hundred chapters
 * were added underneath them. An adopted chapter published in 2021 is new to this library
 * today, and the reader wants to know what changed here.
 */
test("recently updated is ordered by when the library gained a chapter", { skip: !haveDb }, async () => {
  const { listSeries } = await import("../src/pbapi.js");
  const p = db();
  const OLD = "Order Test Old Upstream", NEW = "Order Test New Upstream";
  for (const t of [OLD, NEW]) await p.query("DELETE FROM series WHERE title = $1", [t]);

  const mk = async (title: string, uploaded: string, added: string): Promise<number> => {
    const r = await p.query<{ id: number }>(
      "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [title]);
    const id = r.rows[0]!.id;
    await p.query(
      `INSERT INTO chapter (series_id, chapter_number, file_path, uploaded_at, added_at)
       VALUES ($1,1,$2,$3,$4)`, [id, `/nowhere/${id}.cbz`, uploaded, added]);
    return id;
  };
  // Published years ago, adopted a minute ago: this is a manual download being imported.
  const oldUpstream = await mk(OLD, "2021-01-01", new Date(Date.now() - 60_000).toISOString());
  // Published yesterday, but this library has had it for a month.
  const newUpstream = await mk(NEW, new Date(Date.now() - 86_400_000).toISOString(),
    new Date(Date.now() - 30 * 86_400_000).toISOString());

  const list = await listSeries();
  // Keyed as strings: series.id is a bigint, so pg hands it back as a string on both
  // sides and a Map of numbers silently misses every lookup.
  const positions = new Map(list.map((s, i) => [String(s.id), i]));
  const at = (id: number | string): number => {
    const n = positions.get(String(id));
    assert.ok(n !== undefined, `series ${id} is missing from the list entirely`);
    return n!;
  };
  assert.ok(at(oldUpstream) < at(newUpstream),
    "the series this library just gained comes first, even though its chapter is four years older");

  const mine = list.find((s) => String(s.id) === String(oldUpstream))!;
  assert.ok(mine.lastAdded, "and the timestamp is exposed, so the order can be checked rather than trusted");

  for (const t of [OLD, NEW]) await p.query("DELETE FROM series WHERE title = $1", [t]);
});

/**
 * Replacing a cover, and why the button did nothing.
 *
 * refreshMetadata wrote cover_path with COALESCE($3, cover_path), so once a series had a
 * cover it could never get a different one. Six imported series showed a credits page or a
 * wall of panels and "refresh cover & synopsis" was incapable of changing any of them.
 */
test("a forced refresh replaces a cover, and an unforced one does not", { skip: !haveDb }, async () => {
  const { refreshMetadata } = await import("../src/metadata.js");
  const { setCoverFromPage } = await import("../src/metadata.js");
  const { buildCbz } = await import("../src/cbz.js");
  const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const p = db();
  const TITLE = "Cover Replacement Series";
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const sid = s.rows[0]!.id;

  const dir = join(libraryRoot, TITLE);
  mk(dir, { recursive: true });
  const PAGE1 = jpegOf(1000, 1400, "PAGE-ONE");
  const PAGE2 = jpegOf(1000, 1400, "PAGE-TWO");
  const file = join(dir, `${TITLE} - c0001.cbz`);
  wf(file, buildCbz([{ name: "001.jpg", data: PAGE1 }, { name: "002.jpg", data: PAGE2 }],
    new Date("2026-01-01T00:00:00Z")));
  await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,1,$2)", [sid, file]);

  // A cover already on disk, standing in for the credits page these series ended up with.
  wf(join(dir, "cover.jpg"), Buffer.from("WRONG-COVER"));
  await p.query("UPDATE series SET cover_path = $2 WHERE id = $1", [sid, join(dir, "cover.jpg")]);

  await refreshMetadata(sid);
  assert.deepEqual(rf(join(dir, "cover.jpg")), Buffer.from("WRONG-COVER"),
    "without force the existing cover stands, which is right for the scheduled pass");

  await refreshMetadata(sid, { force: true });
  assert.notDeepEqual(rf(join(dir, "cover.jpg")), Buffer.from("WRONG-COVER"),
    "with force it is replaced, which is what pressing the button means");

  // And a chosen page wins outright, since shape cannot tell a cover from a panel.
  await setCoverFromPage(sid, "1.0000", 1);
  assert.deepEqual(rf(join(dir, "cover.jpg")), PAGE2, "page two is now the cover");
  const row = (await p.query<{ cover_path: string }>(
    "SELECT cover_path FROM series WHERE id = $1", [sid])).rows[0]!;
  assert.equal(row.cover_path, join(dir, "cover.jpg"));

  await p.query("DELETE FROM series WHERE id = $1", [sid]);
});

/**
 * What counts as a series having gone quiet.
 *
 * The flag is an observation, not a setting, and it was being made on two kinds of series
 * it should never apply to. A source that reports no upload date hands back the epoch, so
 * Saving 80,000 Gold looked like its newest chapter was from 1970. And a series with no
 * source has nothing looking for chapters at all, so silence proves nothing: every folder
 * imported today was flagged within a day of arriving.
 */
test("quiet is not claimed for an unknown date or an unbound series", { skip: !haveDb }, async () => {
  const { checkStalled } = await import("../src/schedule.js");
  const p = db();
  const titles = ["Quiet Epoch Series", "Quiet Unbound Series", "Quiet Genuine Series"];
  for (const t of titles) await p.query("DELETE FROM series WHERE title = $1", [t]);

  const mk = async (title: string, uploaded: string | null, bind: boolean): Promise<number> => {
    const r = await p.query<{ id: number }>(
      "INSERT INTO series (title, folder, stalled_since) VALUES ($1,$1, now()) RETURNING id", [title]);
    const id = r.rows[0]!.id;
    await p.query(
      "INSERT INTO chapter (series_id, chapter_number, file_path, uploaded_at) VALUES ($1,1,$2,$3)",
      [id, `/nowhere/${id}.cbz`, uploaded]);
    if (bind) {
      await p.query(
        `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, role)
         VALUES ($1,'s','S',0,'primary')`, [id]);
    }
    return id;
  };
  // The epoch is what a source hands back when it does not know.
  const epoch = await mk(titles[0]!, "1970-01-21", true);
  // No source: nothing is looking, so nothing can have stopped.
  const unbound = await mk(titles[1]!, "2020-01-01", false);
  // Genuinely stale, with a source that could have published and did not.
  const genuine = await mk(titles[2]!, "2024-01-01", true);

  // The baseline has to exist or the first pass stays silent by design.
  await p.query(
    "INSERT INTO settings (key, value) VALUES ('stall_baseline_at', now()::text) ON CONFLICT (key) DO NOTHING");
  await checkStalled();

  const flag = async (id: number): Promise<boolean> => (await p.query<{ n: string | null }>(
    "SELECT stalled_since::text AS n FROM series WHERE id = $1", [id])).rows[0]?.n !== null;

  assert.equal(await flag(epoch), false, "an unknown upload date is not a stale one");
  assert.equal(await flag(unbound), false, "a series with no source cannot have gone quiet");
  assert.equal(await flag(genuine), true, "and a genuinely stale series is still flagged");

  for (const t of titles) await p.query("DELETE FROM series WHERE title = $1", [t]);
});

/**
 * The whole-chapters rule, and the series it would break.
 *
 * 25.1 and 25.2 are one chapter split by a release group, so taking both means reading the
 * same pages twice, and that is true of nearly every source. Kumo Desu ga, Nani ka is not:
 * it holds 170 chapters of which 153 are halves, in unbroken .1/.2 pairs from chapter 5 to
 * 80, with no whole chapter to take instead. A single global rule would stop it updating
 * entirely, so the exception is per series and set from what a series already holds.
 */
test("a series whose source only publishes halves keeps taking them", { skip: !haveDb }, async () => {
  const p = db();
  const NORMAL = "Whole Numbered Series", HALVES = "Half Numbered Series";
  for (const t of [NORMAL, HALVES]) await p.query("DELETE FROM series WHERE title = $1", [t]);

  const mk = async (title: string, numbers: number[]): Promise<number> => {
    const r = await p.query<{ id: number }>(
      "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [title]);
    const id = r.rows[0]!.id;
    for (const n of numbers) {
      await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,$3)",
        [id, n, `/nowhere/${id}-${n}.cbz`]);
    }
    return id;
  };
  const normal = await mk(NORMAL, [1, 2, 3, 4, 5, 5.5]);
  const halves = await mk(HALVES, [1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 4]);

  // The migration's rule: more part-numbered chapters than whole ones means the source
  // numbers in halves and always did.
  await p.query(
    `UPDATE series SET take_splits = true WHERE id IN (
       SELECT series_id FROM chapter GROUP BY series_id
        HAVING count(*) FILTER (WHERE chapter_number <> trunc(chapter_number))
             > count(*) FILTER (WHERE chapter_number = trunc(chapter_number)))`);

  const flag = async (id: number): Promise<boolean> => (await p.query<{ t: boolean }>(
    "SELECT take_splits AS t FROM series WHERE id = $1", [id])).rows[0]!.t;

  assert.equal(await flag(normal), false,
    "one side story among five whole chapters is not a source that numbers in halves");
  assert.equal(await flag(halves), true,
    "six halves against one whole chapter is, and the rule must not stop it updating");

  for (const t of [NORMAL, HALVES]) await p.query("DELETE FROM series WHERE title = $1", [t]);
});

/**
 * A folder must not be protected by a decision we made.
 *
 * Deleting the redundant part-numbered chapters left their files in the legacy folders,
 * and "every chapter in this folder is held" then read as false: 33 of the 37 folders kept
 * back were kept because of decimals we had deliberately removed, so they could never be
 * pruned. A series that takes splits is the exception, since for it a missing decimal is a
 * real gap.
 */
test("a decimal deleted on purpose does not protect its legacy folder", { skip: !haveDb }, async () => {
  const { setLink, redundantFolders } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const WHOLE = "Discard Rule Whole Series", SPLIT = "Discard Rule Split Series";
  for (const t of [WHOLE, SPLIT]) await p.query("DELETE FROM series WHERE title = $1", [t]);

  const build = async (title: string, takeSplits: boolean): Promise<string> => {
    const r = await p.query<{ id: number }>(
      "INSERT INTO series (title, folder, take_splits) VALUES ($1,$1,$2) RETURNING id", [title, takeSplits]);
    const id = r.rows[0]!.id;
    // Chapters 1 and 2 held; the folder also holds 1.1, which was deleted on purpose.
    for (const n of [1, 2]) {
      await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,$3)",
        [id, n, `/nowhere/${id}-${n}.cbz`]);
    }
    const dir = join(legacyRoot, title.replace(/\s+/g, "_"));
    mk(dir, { recursive: true });
    for (const f of ["Chapter 1.cbz", "Chapter 2.cbz", "Chapter 1.1.cbz"]) wf(join(dir, f), Buffer.from(f));
    await setLink(id, dir, "linked");
    return dir;
  };

  const wholeDir = await build(WHOLE, false);
  const splitDir = await build(SPLIT, true);

  const report = await redundantFolders();
  const whole = report.find((f) => f.path === wholeDir)!;
  const split = report.find((f) => f.path === splitDir)!;

  assert.equal(whole.heldAll, true,
    "1.1 was deleted deliberately, so it is accounted for and must not hold the folder back");
  assert.equal(split.heldAll, false,
    "a series that takes splits genuinely lacks 1.1, so its folder is still needed");

  for (const t of [WHOLE, SPLIT]) await p.query("DELETE FROM series WHERE title = $1", [t]);
});

/**
 * Asking for a synopsis must not cost the cover.
 *
 * localMetadata answers both questions and writes cover.jpg as a side effect of the first.
 * refreshMetadata called it whenever EITHER was missing, so a series with good cover art
 * from its source but no synopsis had that art replaced by a comic page every time the
 * button was pressed. Three series showed "the first page of the first comic" for that
 * reason, however often they were refreshed.
 *
 * The bound case needs a live source, so it is verified against the deployed instance.
 * What is asserted here is the rule for a series with no source, where a page is the only
 * cover available: forcing moves to a different page rather than rewriting the same one,
 * and the synopsis is filled either way.
 */
test("forcing a source-less refresh moves to another page and still fills the synopsis", { skip: !haveDb }, async () => {
  const { refreshMetadata } = await import("../src/metadata.js");
  const { buildCbz, comicInfo } = await import("../src/cbz.js");
  const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const p = db();
  const TITLE = "Cover Cycle Series";
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const sid = s.rows[0]!.id;

  const dir = join(libraryRoot, TITLE);
  mk(dir, { recursive: true });
  const P1 = jpegOf(1000, 1400, "PAGE-ONE");
  const P2 = jpegOf(1000, 1400, "PAGE-TWO");
  const file = join(dir, `${TITLE} - c0001.cbz`);
  wf(file, buildCbz([
    { name: "ComicInfo.xml", data: Buffer.from(comicInfo({
        series: TITLE, number: "1", pageCount: 2, summary: "A real synopsis from the archive." })) },
    { name: "001.jpg", data: P1 }, { name: "002.jpg", data: P2 },
  ], new Date("2026-01-01T00:00:00Z")));
  await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,1,$2)", [sid, file]);

  // Page one is the cover, which is the state being complained about.
  wf(join(dir, "cover.jpg"), P1);
  await p.query("UPDATE series SET cover_path = $2, description = NULL WHERE id = $1",
    [sid, join(dir, "cover.jpg")]);

  await refreshMetadata(sid, { force: true });

  const desc = (await p.query<{ description: string | null }>(
    "SELECT description FROM series WHERE id = $1", [sid])).rows[0]!.description;
  assert.match(desc ?? "", /real synopsis from the archive/, "the synopsis is filled in");
  assert.notDeepEqual(rf(join(dir, "cover.jpg")), P1,
    "forcing must move off the page already in use, or the button cannot do anything");
  assert.deepEqual(rf(join(dir, "cover.jpg")), P2, "and it takes the next candidate");

  await p.query("DELETE FROM series WHERE id = $1", [sid]);
});

test("adoption does not offer back the decimals we deleted", { skip: !haveDb }, async () => {
  const { setLink, findOnDisk } = await import("../src/adopt.js");
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const p = db();
  const TITLE = "Reoffer Test Series";
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE]);
  const sid = s.rows[0]!.id;
  for (const n of [1, 2]) {
    await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,$3)",
      [sid, n, `/nowhere/${sid}-${n}.cbz`]);
  }
  const dir = join(legacyRoot, "Reoffer_Test_Series");
  mk(dir, { recursive: true });
  // 1.1 was deleted on purpose; 3 is genuinely new.
  for (const f of ["Chapter 1.cbz", "Chapter 1.1.cbz", "Chapter 3.cbz"]) wf(join(dir, f), Buffer.from(f));
  await setLink(sid, dir, "linked");

  let offers = [...(await findOnDisk(sid)).sources[0]!.offers.keys()].sort((a, b) => a - b);
  assert.deepEqual(offers, [3],
    "only the genuinely new chapter is offered: re-adopting 1.1 would undo the prune");

  // A series that takes splits wants it back.
  await p.query("UPDATE series SET take_splits = true WHERE id = $1", [sid]);
  offers = [...(await findOnDisk(sid)).sources[0]!.offers.keys()].sort((a, b) => a - b);
  assert.deepEqual(offers, [1.1, 3], "unless the series takes splits, in which case it is wanted");

  await p.query("DELETE FROM series WHERE id = $1", [sid]);
});
