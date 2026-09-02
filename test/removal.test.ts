import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Covers the one code path in this project that deletes files.
 *
 * planRemoval builds candidate legacy folders by guessing: source name plus a sanitized
 * title. Existing is not proof that a folder belongs to this series, so a decoy with the
 * same name but unrelated contents must be excluded. That is the difference between
 * freeing space and destroying another series.
 */
const root = mkdtempSync(join(tmpdir(), "kupo-rm-"));
const legacyRoot = join(root, "Manga");
const libraryRoot = join(root, "Library");

process.env["LEGACY_ROOT"] = legacyRoot;
process.env["LIBRARY_ROOT"] = libraryRoot;
process.env["DATABASE_URL"] = process.env["TEST_DATABASE_URL"]
  ?? "postgres://postgres:test@127.0.0.1:55444/kupoyomi";

const { planRemoval } = await import("../src/remove.js");
const { db, migrate, closeDb } = await import("../src/db.js");

// Needs a real Postgres. Skipped rather than failed when none is configured, so a
// checkout without docker still runs the unit tests.
let haveDb = false;
try {
  await db().query("SELECT 1");
  haveDb = true;
} catch {
  console.log("no database reachable, skipping the removal integration test");
}

const SERIES = "Test Series";
const REAL = join(legacyRoot, "RealSource (EN)", SERIES);
const DECOY = join(legacyRoot, "DecoySource (EN)", SERIES);
const CANON = join(libraryRoot, SERIES);

before(async () => {
  if (!haveDb) return;
  await migrate();
  const p = db();
  await p.query("DELETE FROM series WHERE title = $1", [SERIES]);

  mkdirSync(REAL, { recursive: true });
  mkdirSync(DECOY, { recursive: true });
  mkdirSync(CANON, { recursive: true });

  // Two chapters that really belong to this series, hardlinked into the library the way
  // an adopted migration leaves them.
  for (const n of [1, 2]) {
    const src = join(REAL, `Chapter ${n}.cbz`);
    writeFileSync(src, Buffer.from(`real chapter ${n}`));
    linkSync(src, join(CANON, `${SERIES} - c000${n}.cbz`));
  }
  // A folder that the guess will also produce, holding files with identical names that
  // are nothing to do with us.
  for (const n of [1, 2]) {
    writeFileSync(join(DECOY, `Chapter ${n}.cbz`), Buffer.from(`unrelated ${n}`));
  }

  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$2) RETURNING id", [SERIES, SERIES]);
  const id = s.rows[0]!.id;
  for (const n of [1, 2]) {
    await p.query(
      "INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,$3)",
      [id, n, join(CANON, `${SERIES} - c000${n}.cbz`)]);
  }
  for (const name of ["RealSource (EN)", "DecoySource (EN)"]) {
    await p.query(
      `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, role)
       VALUES ($1,$2,$3,0,$4)`,
      [id, name, name, name === "RealSource (EN)" ? "active" : "former"]);
  }
});

after(async () => {
  if (!haveDb) return;
  const p = db();
  await p.query("DELETE FROM series WHERE title = $1", [SERIES]);
  await closeDb();
});

test("a decoy folder the guess produces is not offered for deletion", { skip: !haveDb }, async () => {
  const p = db();
  const id = (await p.query<{ id: number }>("SELECT id FROM series WHERE title = $1", [SERIES])).rows[0]!.id;
  const plan = await planRemoval(id);

  assert.equal(plan.chapters, 2);
  assert.equal(plan.canonicalFiles, 2, "both chapters resolve");
  assert.equal(plan.sharedFiles, 2, "both are hardlinks, so deleting the library copy frees nothing");

  const paths = plan.legacyDirs.map((d) => d.path);
  assert.ok(paths.includes(REAL), `the folder holding our inodes is offered: ${JSON.stringify(paths)}`);
  assert.ok(!paths.includes(DECOY),
    `a same-named folder with unrelated files must NOT be offered: ${JSON.stringify(paths)}`);
  assert.ok(existsSync(join(DECOY, "Chapter 1.cbz")), "decoy still intact");
});
