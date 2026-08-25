import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The search page's grouping, exercised as the real thing rather than a copy.
 *
 * The client block lives in a String.raw template and ships to the browser, so nothing
 * here ever ran it. It only got checked for parsing, which is why two bugs sat in it:
 * variantOf dropped the first tag, so "Kill the Villainess [Official]" reported no
 * release at all, and workKey stripped every bracket, so season 3 was folded into the
 * same card as the main run.
 *
 * The block is pulled out of the source and evaluated with the browser globals stubbed,
 * so the functions under test are the ones the page actually uses.
 */
const src = readFileSync("src/ui/searchpage.ts", "utf8");
const block = /String\.raw`([\s\S]*?)`;/.exec(src)?.[1] ?? "";
assert.ok(block.length > 0, "the client block is still a String.raw template");
const upTo = block.indexOf("const es = new EventSource");
assert.ok(upTo > 0, "the EventSource wiring is still the boundary of the testable part");

const stubs = "const location={search:'?q=x'};"
  + "const document={getElementById:()=>null,createElement:()=>({}),addEventListener:()=>{}};"
  + "const window={HAVE:{}};";
const fns = new Function(`${stubs}\n${block.slice(0, upTo)}\nreturn { workKey, variantOf, mergeKey, norm };`)() as {
  workKey: (s: string) => string;
  variantOf: (s: string) => string;
  mergeKey: (k: string) => string;
  norm: (s: string) => string;
};

test("editions of one work group together", () => {
  const k = fns.workKey("Kill the Villainess");
  for (const t of ["Kill the Villainess (Comic)", "Kill the Villainess [Official]",
                   "KILL THE VILLAINESS", "Kill the Villainess [English] [Some Group]"]) {
    assert.equal(fns.workKey(t), k, `${t} is the same work`);
  }
});

test("a season or part is a different run and gets its own card", () => {
  const main = fns.workKey("Kill the Villainess");
  for (const t of ["Kill The Villainess [S3]", "Kill the Villainess [Season 2]",
                   "Kill the Villainess (Part 2)", "Kill the Villainess [Vol 3]"]) {
    assert.notEqual(fns.workKey(t), main,
      `${t} is a different run of chapters and must not be folded into the main card`);
  }
  // And two mentions of the same season still group with each other.
  assert.equal(fns.workKey("Kill The Villainess [S3]"), fns.workKey("Kill the Villainess [s3]"));
});

test("every tag is reported as the release, not all but the first", () => {
  assert.equal(fns.variantOf("Kill the Villainess [Official]"), "Official");
  assert.equal(fns.variantOf("Kill the Villainess (Comic)"), "Comic");
  assert.equal(fns.variantOf("Kill The Villainess [S3]"), "S3");
  assert.equal(fns.variantOf("Some Title [English] [Scanlator]"), "English · Scanlator");
  // A digital marker says nothing about which release this is.
  assert.equal(fns.variantOf("Another Title [Digital]"), "");
  assert.equal(fns.variantOf("Plain Title"), "");
});

test("a short title is never merged by edit distance", () => {
  // Two edits on a short name is a different work, not a typo.
  assert.equal(fns.mergeKey("bleach"), "bleach");
  assert.equal(fns.mergeKey("naruto"), "naruto");
});

/**
 * Which card answers what was typed.
 *
 * Sources answer in whatever order they answer, so searching "My Dress-Up Darling" put it
 * fifth behind four titles that merely share a word, and its chapter count was fetched
 * behind theirs. Relevance decides both the display order and which detail call goes first.
 */
// The block reads the query out of location.search itself, so the stub supplies it rather
// than the harness declaring a second q.
const relStubs = stubs.replace("location={search:'?q=x'}",
  "location={search:'?q=' + encodeURIComponent('My Dress-Up Darling')}");
const rel = new Function(`${relStubs}\n${block.slice(0, upTo)}\nreturn relevance;`)() as (t: string) => number;

test("the title searched for outranks a loose match", () => {
  assert.equal(rel("My Dress-Up Darling"), 0, "an exact match is first");
  assert.ok(rel("My Dress-Up Darling: Extra") <= 1, "a title starting with it is next");
  assert.ok(rel("The My Dress-Up Darling Story") <= 2, "one containing it comes after that");
  // Shares two words and is a different work.
  assert.ok(rel("My Darling Is a Dress Maker") > 2,
    "a title that merely shares words must rank below one that contains the whole phrase");
  assert.ok(rel("Completely Unrelated Manga") > 3, "and something unrelated is last");
});

test("ranking is a total order, so ties keep arrival order", () => {
  // Two loose matches must score the same rather than one jumping the other arbitrarily.
  assert.equal(rel("Some Other Thing"), rel("Another Thing Entirely"));
});
