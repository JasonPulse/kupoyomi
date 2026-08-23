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
