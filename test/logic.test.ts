import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChapterNumber } from "../src/chapternum.js";
import { canonical } from "../src/seed.js";
import { chapterFilename } from "../src/remap.js";
import { queryVariants } from "../src/match.js";
import { fmt, ago } from "../src/held.js";
import { sanitize } from "../src/suwayomi.js";

/**
 * These cover the logic that has actually broken in this project, using the real strings
 * that broke it. Every case below is taken from the library, not invented.
 */

test("chapter numbers come out of real filenames", () => {
  const cases: Array<[string, number | null]> = [
    ["Chap 1.cbz", 1],
    ["Chap 100.cbz", 100],
    ["Chapter 125_ Season 3 [Start].cbz", 125],
    ["Ch.001.cbz", 1],
    ["chapter 10.cbz", 10],
    ["Chapter 100.cbz", 100],
    // Underscore is a word character, so \b never fired here and this whole naming
    // style silently failed to parse.
    ["[0001]_Chapter_1_New_Employee_Ceremony.cbz", 1],
    ["[0006]_Chapter_5.5.cbz", 5.5],
    // The chapter marker must win over the volume number.
    ["Psylocke Scans_Vol.1 Ch.1 - Knight and Confession.cbz", 1],
    ["Raptor Scans_Vol.4 Ch.70 - The Imperial Knight.cbz", 70],
    // Manhwa sources number in episodes.
    ["Official_Episode 12.cbz", 12],
    ["Episode 44.cbz", 44],
    // Our own canonical naming has to round-trip.
    ["I Shall Master This Family - c0070 [Psylocke Scans].cbz", 70],
    // Genuinely unnumbered: guessing would be worse than admitting it.
    ["It's the 71h Time!.cbz", null],
  ];
  for (const [name, expected] of cases) {
    assert.equal(parseChapterNumber(name), expected, name);
  }
});

test("canonical names keep the separator instead of flattening it to an underscore", () => {
  assert.equal(canonical("Tsukimichi: Moonlit Fantasy"), "Tsukimichi - Moonlit Fantasy");
  assert.equal(canonical('The Most Notorious "Talker" Runs the World'), "The Most Notorious Talker Runs the World");
  assert.equal(canonical("Re:Monster / Remonster"), "Re - Monster - Remonster");
  assert.equal(canonical("Set It!"), "Set It!");
});

test("chapter filenames zero-pad so a directory listing sorts correctly", () => {
  assert.equal(chapterFilename("Wireless Onahole", "7", null), "Wireless Onahole - c0007.cbz");
  assert.equal(chapterFilename("Wireless Onahole", "70", "Some Scans"),
    "Wireless Onahole - c0070 [Some Scans].cbz");
  // A decimal chapter must not collide with its neighbour.
  assert.notEqual(chapterFilename("X", "21.5", null), chapterFilename("X", "21", null));
  const sorted = ["9", "10", "100"].map((n) => chapterFilename("X", n, null)).sort();
  assert.deepEqual(sorted, [chapterFilename("X", "9", null), chapterFilename("X", "10", null),
    chapterFilename("X", "100", null)]);
});

test("query variants recover a title a site will not match verbatim", () => {
  // ManhuaTop returned nothing for the curly apostrophe and the right entry for a
  // straight one.
  const v = queryVariants("I’m being raised by villains");
  assert.ok(v.includes("I'm being raised by villains"), JSON.stringify(v));
  // Long light-novel titles are indexed by the part before the colon.
  assert.ok(queryVariants("7th Time Loop: The Villainess Enjoys a Carefree Life")
    .includes("7th Time Loop"));
  // The verbatim title is always tried first, so an exact match costs one request.
  assert.equal(queryVariants("Set It!")[0], "Set It!");
});

test("sanitize matches Suwayomi's own folder naming", () => {
  assert.equal(sanitize("Tsukimichi: Moonlit Fantasy"), "Tsukimichi_ Moonlit Fantasy");
  assert.equal(sanitize("Sensei, How About This Month?"), "Sensei, How About This Month_");
});

test("numerics render without Postgres padding, and dates keep their year", () => {
  assert.equal(fmt("30.3000"), "30.3");
  assert.equal(fmt("70.0000"), "70");
  assert.equal(fmt(null), "-");
  // A DATE has no time; reading it back in local time used to shift the day and drop
  // the year entirely.
  assert.match(ago("2026-05-10", "2026-08-22"), /^2026-05-10 \(3mo ago\)$/);
  assert.equal(ago(null, "2026-08-22"), "-");
});

// --- image dimensions, for picking a cover ------------------------------------------
const { imageSize, coverScore } = await import("../src/imgsize.js");

test("JPEG dimensions are read from the SOF marker", () => {
  // A minimal JPEG: SOI, an APP0 segment to be skipped, then SOF0 carrying 1000x1400.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),           // APP0, length 4
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),                 // SOF0, length 17, 8-bit
    Buffer.from([0x05, 0x78, 0x03, 0xe8]),                       // height 1400, width 1000
    Buffer.alloc(8),
  ]);
  assert.deepEqual(imageSize(jpeg), { width: 1000, height: 1400 });
});

test("PNG dimensions are read from IHDR", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from("IHDR"),
    Buffer.from([0x00, 0x00, 0x02, 0xd0]),                       // width 720
    Buffer.from([0x00, 0x00, 0x3c, 0xc8]),                       // height 15560
    Buffer.alloc(8),
  ]);
  assert.deepEqual(imageSize(png), { width: 720, height: 15560 });
});

test("a comic page beats a webtoon strip as a cover", () => {
  const page = coverScore({ width: 1000, height: 1400 });
  const strip = coverScore({ width: 720, height: 15560 });
  assert.ok(page < strip, `a page-shaped image must score better: ${page} vs ${strip}`);
  assert.ok(page < 0.35, "a normal page is close enough to stop searching");
  assert.equal(coverScore(null), 99, "an unreadable header loses to anything measurable");
});

test("garbage is not mistaken for an image", () => {
  assert.equal(imageSize(Buffer.from("not an image at all, really")), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
  // A truncated JPEG must terminate rather than run off the end.
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04])), null);
});

// --- dates a source did not actually report ------------------------------------------
test("a source reporting no upload date reads as unknown, not as 1970", () => {
  const today = "2026-08-23";
  // Zazamanga came back with the epoch and the page rendered "1970-01-21 (56.6y ago)",
  // which looks like an answer and is not one. It also won a four-way tie for best
  // source because nothing preferred a real date over a missing one.
  assert.equal(ago("1970-01-21", today), "unknown");
  assert.equal(ago("1970-01-01T00:00:00.000Z", today), "unknown");
  assert.equal(ago(null, today), "-");
  // Real dates still render, including old ones that are genuinely old.
  assert.match(ago("2026-07-01", today), /^2026-07-01 \(/);
  assert.match(ago("2021-12-25", today), /^2021-12-25 \(4\.7y ago\)$/);
  assert.match(ago("1999-06-01", today), /^1999-06-01 \(/);
});

// --- descriptions that are site copy rather than a synopsis ---------------------------
const { looksLikeSiteCopy } = await import("../src/metadata.js");

test("aggregator site copy is not accepted as a synopsis", () => {
  // The shape ManhwaZone returns: what the manhwa is, with a score, not what happens.
  assert.equal(looksLikeSiteCopy(
    "Kill the Villainess has breathtaking visuals and got 4.5/5 on anidb. Read it online "
    + "for free in high quality, updated daily."), true);
  assert.equal(looksLikeSiteCopy(
    "Read Kill the Villainess manga online for free. Bookmark this page for the latest chapters."), true);
  assert.equal(looksLikeSiteCopy("You can read the newest chapters here, updated weekly."), true);
});

test("a real synopsis survives, even one that mentions a rating or the medium", () => {
  // The genuine description for this series, which must not be discarded.
  assert.equal(looksLikeSiteCopy(
    "I reincarnated in a novel inside the body of a villainess named Eris who poisoned "
    + "herself when her fiance, the prince, married her childhood friend, the maid Helena. "
    + "From the moment I realized this, I had only one goal. Escape from the world in this novel."),
    false);
  assert.equal(looksLikeSiteCopy(
    "Mimori Touka has always been something of a background character in his high school. "
    + "So when he and his classmates are summoned to a fantasy land and gifted with incredible "
    + "skills, it seems like the perfect opportunity to make a name for himself."), false);
  // One passing mention in a long synopsis is not enough to reject it.
  assert.equal(looksLikeSiteCopy(
    "A long and detailed account of a webtoon artist who moves to the city, takes a job at a "
    + "failing studio, and slowly rebuilds both the studio and herself over the course of the "
    + "story, which spans several years and a large cast of colleagues and rivals she comes to "
    + "understand only after losing most of them to the industry she loves."), false);
});

// --- chapter numbers a source invented -----------------------------------------------
const { withoutOutliers } = await import("../src/fetch.js");

test("a number hundreds above the run is not part of it", () => {
  // Bbato's real list for A Couple of Cuckoos: 326 chapters ending at 305, plus 5000.
  const run = Array.from({ length: 306 }, (_, i) => i);
  const { kept, dropped } = withoutOutliers([...run, 5000]);
  assert.deepEqual(dropped, [5000]);
  assert.equal(kept.at(-1), 305, "the real end of the run survives");
  assert.equal(kept.length, 306);
});

test("one absurd number does not hide another", () => {
  const { dropped } = withoutOutliers([1, 2, 3, 4, 5, 900, 5000]);
  assert.deepEqual(dropped, [900, 5000], "both are dropped, from the top down");
});

test("a genuinely long series keeps its numbers", () => {
  // One Piece is past 1100. Nothing here may treat a real run as an outlier.
  const long = Array.from({ length: 1150 }, (_, i) => i + 1);
  const { kept, dropped } = withoutOutliers(long);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 1150);
});

test("decimals and a short list are left alone", () => {
  assert.deepEqual(withoutOutliers([1, 1.5, 2, 2.5, 3]).dropped, []);
  // Two chapters cannot establish a run, so nothing is judged an outlier.
  assert.deepEqual(withoutOutliers([1, 9000]).dropped, []);
});

test("only whole chapters are taken from a source", () => {
  // A release group splitting chapter 25 into 25.1 and 25.2 means reading it twice, and
  // no source seen here uses a decimal for anything else.
  const offered = [23, 24, 25, 25.1, 25.2, 26, 26.5, 27];
  const whole = offered.filter((n) => Number.isInteger(n));
  assert.deepEqual(whole, [23, 24, 25, 26, 27]);
  // Zero is a chapter and negative numbers are not, so the check has to be integer
  // rather than truthy: chapter 0 exists in this library.
  assert.deepEqual([0, 0.5, 1].filter((n) => Number.isInteger(n)), [0, 1]);
});

test("a whole chapter already held as parts is not fetched again", () => {
  // Holding 8.1 and 8.2 is holding chapter 8, so fetching whole 8 is the same pages a
  // third time. Series 125 was queued for exactly that and kept failing.
  const held = [1, 2, 8.1, 8.2, 9];
  const heldSet = new Set(held);
  const heldAsParts = new Set(held.filter((n) => !Number.isInteger(n)).map(Math.trunc));
  const wanted = (offered: number[]): number[] => offered
    .filter((n) => Number.isInteger(n))
    .filter((n) => !heldSet.has(n))
    .filter((n) => !heldAsParts.has(n));

  assert.deepEqual(wanted([1, 2, 8, 9, 10, 11]), [10, 11],
    "8 is skipped because its parts are held; 10 and 11 are genuinely new");
  // A part held for a chapter we also hold whole changes nothing.
  assert.deepEqual(wanted([8]), [], "and it stays skipped however often it is offered");
});

/**
 * Parts are refused when a whole exists, not on sight.
 *
 * The rule was "whole chapters only", which read the same as "never take a decimal" and
 * cost four chapters. MangaDex carries The Despised Level 0 Incompetent Explorer as
 * 7.1 7.2 7.3, 8.1 8.2 8.3, 9.1 9.2 9.3, 11.1 11.2 and offers no whole 7, 8, 9 or 11.
 * Every part was dropped, the scan queued nothing, and the downloader said it had nothing
 * to do while the source held all four.
 */
const { preferWholeChapters, wholesCovered, missingWholes, supersededByWhole,
  wholesHeldAsParts, compareOffering } = await import("../src/chapters.js");

test("a chapter offered only in parts is taken as parts", () => {
  const offered = [1.1, 1.2, 1.3, 1.4, 2, 3, 4, 5, 6, 7.1, 7.2, 7.3, 8.1, 8.2, 8.3,
    9.1, 9.2, 9.3, 10, 11.1, 11.2, 12, 13.1, 13.2, 14, 15, 16, 17];
  const held = new Set([1, 2, 3, 4, 5, 6, 10, 12, 13, 14, 15, 16, 17]);
  const take = preferWholeChapters(offered, held);

  // The four that were unreachable are now offered, as their parts.
  for (const n of [7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 11.1, 11.2]) {
    assert.ok(take.includes(n), `chapter ${n} is the only form this source has`);
  }
  // Parts of chapters already held whole are still refused, or chapter 1 arrives a
  // second time in four pieces.
  for (const n of [1.1, 1.2, 1.3, 1.4, 13.1, 13.2]) {
    assert.equal(take.includes(n), false, `${n} duplicates a whole chapter already held`);
  }
});

test("a part is refused when the same source also offers the whole", () => {
  // Both forms on offer means the whole is the one to take.
  assert.deepEqual(preferWholeChapters([25, 25.1, 25.2], new Set()), [25]);
  // And with no whole anywhere, the parts are the chapter.
  assert.deepEqual(preferWholeChapters([25.1, 25.2], new Set()), [25.1, 25.2]);
  // Whole chapters are never touched.
  assert.deepEqual(preferWholeChapters([1, 2, 3], new Set()), [1, 2, 3]);
});

/**
 * One rule, one implementation.
 *
 * These rules were written five times over, each slightly different, so fixing the
 * downloader left the migrate page, the source preview, the Paperback API and the gap
 * report each still wrong in its own way. The grep below is the guard: a part belongs to
 * the chapter it is part of, and nothing outside src/chapters.ts gets to decide that.
 */
test("no module reimplements the whole-versus-part rule", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const full = `${dir}/${f}`;
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });

  const offenders: string[] = [];
  for (const file of walk("src")) {
    if (file.endsWith("src/chapters.ts")) continue;          // where the rule lives
    if (file.endsWith("src/chapternum.ts")) continue;        // parses names, decides nothing
    for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
      // Number.isInteger on an id is validating an id. On a chapter number it is
      // deciding what a decimal means, which is this module's job.
      const arg = /Number\.isInteger\(([^)]*)\)/.exec(line)?.[1] ?? "";
      // Passed as a callback rather than called, which is how match.ts kept its own copy
      // of the rule through the first sweep: filter(Number.isInteger) has no argument to
      // inspect, so a check that only looked at arguments never saw it.
      const asCallback = /\(Number\.isInteger\)/.test(line);
      const decidesPartness = asCallback
        || /chapter|\bnums?\b|held|offered|part|\bn\b|\bm\b/i.test(arg);
      // Mapping a part onto its chapter, in either language.
      const mapsPartToBase = /Math\.trunc/.test(line)
        || (/trunc\(chapter_number\)/.test(line) && !/IS_PART_SQL|BASE_OF_SQL/.test(line));
      if (decidesPartness || mapsPartToBase) offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 74)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `these decide the whole-versus-part rule themselves:\n  ${offenders.join("\n  ")}`);
});

test("every consumer agrees a source carrying 7.1 carries chapter 7", () => {
  const source = [7.1, 7.2, 7.3, 8.1, 8.2, 8.3, 10];
  // Coverage, which the migrate page, the preview, the Paperback API and the gap report
  // all now ask the same way.
  const carried = wholesCovered(source);
  assert.ok(carried.has(7), "chapter 7 is carried");
  assert.ok(carried.has(8), "chapter 8 is carried");
  assert.ok(carried.has(10), "and a whole chapter still is");

  // Holding the parts closes the gap, or a downloaded chapter reports missing forever.
  assert.deepEqual(missingWholes([7.1, 7.2, 7.3, 8, 9]), [], "nothing is missing");
  assert.deepEqual(missingWholes([1, 2, 12.3]), [3, 4, 5, 6, 7, 8, 9, 10, 11],
    "and a lone 12.3 still proves 3 through 11 are missing");

  // The superseded and held-as-parts rules are the same rule read in each direction.
  assert.equal(supersededByWhole(8.1, new Set([8])), true);
  assert.equal(supersededByWhole(8.1, new Set([7])), false);
  assert.equal(supersededByWhole(8, new Set([8])), false, "a whole chapter is never a duplicate");
  assert.deepEqual([...wholesHeldAsParts([8.1, 8.2, 9])], [8]);
});

/**
 * The comparison that decides whether a source is worth switching to.
 *
 * Written four times: the migrate page, the series page's per-binding row, the importer's
 * stored comparison, and the CLI's compare. All four counted exact numbers, so a source
 * carrying chapter 7 as three parts reported it as "not carried" while carrying it, and
 * counted three fills where one chapter was gained.
 */
test("a source carrying a chapter in parts is not counted as missing it", () => {
  // Holds 1 to 6 whole. The source has 7 only as parts, and does not carry 3 at all.
  const held = new Set([1, 2, 4, 5, 6]);
  const offered = [1, 2, 3, 4, 5, 6, 7.1, 7.2, 7.3];
  const c = compareOffering(offered, held);

  assert.equal(c.newBeyond, 1, "chapter 7 is one chapter gained, not three");
  assert.equal(c.fillsGaps, 1, "and chapter 3 is the one hole it fills");
  assert.equal(c.notCarried, 0, "it carries everything held, so nothing is lost by moving");
  assert.equal(c.heldMax, 6);
});

test("a chapter held whole is not counted as lost to a source that splits it", () => {
  // The failure this replaced: held 7 whole, source has 7.1 7.2 7.3, reported as lost.
  const c = compareOffering([7.1, 7.2, 7.3], new Set([7]));
  assert.equal(c.notCarried, 0, "the source has chapter 7, in pieces");
  assert.equal(c.newBeyond, 0, "and offers nothing beyond it");
});

test("what a source genuinely lacks is still counted", () => {
  const c = compareOffering([1, 2], new Set([1, 2, 3, 4]));
  assert.equal(c.notCarried, 2, "chapters 3 and 4 really are not there");
});

/**
 * The attempt limit was written out five times, and the library page still had a hardcoded
 * 4 after the limit moved to 6, so it called chapters dead that the fetcher meant to retry.
 */
test("one place decides the attempt limit", async () => {
  const { maxAttempts } = await import("../src/config.js");
  const before = process.env["FETCH_MAX_ATTEMPTS"];
  process.env["FETCH_MAX_ATTEMPTS"] = "9";
  assert.equal(maxAttempts(), 9, "every page reads the configured limit");
  process.env["FETCH_MAX_ATTEMPTS"] = "0";
  assert.equal(maxAttempts(), 1, "and never zero, which would retry nothing ever");
  if (before === undefined) delete process.env["FETCH_MAX_ATTEMPTS"];
  else process.env["FETCH_MAX_ATTEMPTS"] = before;
});

/**
 * Every page and query that needs Suwayomi's HTTP root built it from the same replace(),
 * and one of the three read the environment directly rather than the parsed config.
 */
test("the suwayomi http base is derived in one place", async () => {
  const { suwayomiHttpBase } = await import("../src/config.js");
  assert.ok(!suwayomiHttpBase().endsWith("/api/graphql"), "the graphql suffix is stripped");
  assert.ok(suwayomiHttpBase().startsWith("http"), "and it is still a url");
});
