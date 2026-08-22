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
    const cases = [
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
    assert.equal(chapterFilename("Wireless Onahole", "70", "Some Scans"), "Wireless Onahole - c0070 [Some Scans].cbz");
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
//# sourceMappingURL=logic.test.js.map