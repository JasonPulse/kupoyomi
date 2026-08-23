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
