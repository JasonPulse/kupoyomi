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

/**
 * A directory left on disk is a failed removal, not a detail.
 *
 * rmSync unlinks every file and then removes the directory. On the CIFS share the listing
 * has not caught up by the time rmdir runs, so it fails on a directory it has just
 * emptied. removeSeries did the files first and the ledger second, so the throw landed
 * between them: "The Inferior Magic Swordsman" lost all 104 files and kept all 104 rows.
 *
 * The first fix treated a surviving empty directory as cosmetic and deleted the series
 * anyway. That is the ledger overruling the disk, and the disk is the source of truth: a
 * folder still on disk means the series is still on disk. So it fails, and it leaves the
 * two in agreement about what is actually there.
 */
test("a directory left on disk fails the removal and reconciles the ledger", async () => {
  const { removeTree } = await import("../src/remove.js");
  const { mkdirSync, mkdtempSync, writeFileSync, chmodSync, existsSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const parent = mkdtempSync(join(tmpdir(), "kupo-rm-"));
  const dir = join(parent, "series");
  mkdirSync(dir);

  // A read-only parent is the closest reproduction available offline: the files inside go,
  // and rmdir on the child then fails for a reason outside our control, as on the share.
  // Two shapes of failure and both must be one: rmSync raising, and rmSync returning
  // success while the directory is still there, which it has done against this share.
  // What is asserted is the property rather than the message.
  chmodSync(parent, 0o500);
  try {
    assert.throws(() => removeTree(dir),
      "an empty directory left behind is a failure, because the disk still has it");
    assert.ok(existsSync(dir), "and it really is still there");
  } finally {
    chmodSync(parent, 0o700);
  }

  // A directory holding files fails too, and touches nothing.
  writeFileSync(join(dir, "ch1.cbz"), "x");
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => removeTree(dir));
    assert.equal(readdirSync(dir).length, 1, "the file is untouched");
  } finally {
    chmodSync(dir, 0o700);
  }

  // And when it does go, it goes quietly.
  removeTree(dir);
  assert.equal(existsSync(dir), false);
});

/**
 * The ledger is made to match the disk for one series, which is what a failed removal
 * needs so it never leaves rows claiming files that are gone.
 */
test("reconciling one series drops only its rows for missing files", { skip: !haveDb }, async () => {
  const { dropMissingFiles } = await import("../src/prune.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const p = db();

  const dir = mkdtempSync(join(tmpdir(), "kupo-led-"));
  const real = join(dir, "here.cbz");
  writeFileSync(real, "x");

  const mk = async (title: string): Promise<number> => {
    await p.query("DELETE FROM series WHERE title = $1", [title]);
    return (await p.query<{ id: number }>(
      "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [title])).rows[0]!.id;
  };
  const mine = await mk("Ledger Under Test");
  const other = await mk("Ledger Left Alone");
  for (const id of [mine, other]) {
    await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,1,$2)", [id, real]);
    await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,2,$2)",
      [id, join(dir, "gone.cbz")]);
  }

  assert.equal(await dropMissingFiles(mine), 1, "the row whose file is gone is dropped");
  const left = await p.query<{ n: string }>(
    "SELECT count(*) n FROM chapter WHERE series_id = $1", [mine]);
  assert.equal(Number(left.rows[0]!.n), 1, "and the one still on disk stays");
  const untouched = await p.query<{ n: string }>(
    "SELECT count(*) n FROM chapter WHERE series_id = $1", [other]);
  assert.equal(Number(untouched.rows[0]!.n), 2, "another series is not touched");

  for (const t of ["Ledger Under Test", "Ledger Left Alone"]) {
    await p.query("DELETE FROM series WHERE title = $1", [t]);
  }
});

test("streaming a file that cannot be opened answers once and does not throw", async () => {
  const { streamFile } = await import("../src/server.js");

  type Handlers = Record<string, () => void>;
  const fakeStream = (): { once: (e: string, f: () => void) => unknown; pipe: (d: never) => unknown;
                           fire: (e: string) => void; piped: () => boolean } => {
    const handlers: Handlers = {};
    let piped = false;
    return {
      once(ev, fn) { handlers[ev] = fn; return this; },
      pipe() { piped = true; return null; },
      fire(ev) { handlers[ev]?.(); },
      piped: () => piped,
    };
  };
  const fakeRes = (): { writeHead: (c: number) => unknown; end: () => unknown;
                        headersSent: boolean; codes: number[] } => {
    const codes: number[] = [];
    return {
      codes,
      headersSent: false,
      writeHead(c) {
        if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
        codes.push(c); this.headersSent = true; return this;
      },
      end() { return this; },
    };
  };

  // A stream that never opens, which is what a deleted file gives you.
  const bad = fakeStream();
  const res1 = fakeRes();
  streamFile(res1, "/nowhere/gone.jpg", { "content-type": "image/jpeg" }, () => bad);
  bad.fire("error");
  assert.deepEqual(res1.codes, [404], "one status, and it is the failure");
  assert.equal(bad.piped(), false, "nothing was piped from a stream that never opened");

  // The success path writes 200 exactly once, and only after the file opens.
  const good = fakeStream();
  const res2 = fakeRes();
  streamFile(res2, "/somewhere/real.jpg", { "content-type": "image/jpeg" }, () => good);
  assert.deepEqual(res2.codes, [], "nothing is written before the file opens");
  good.fire("open");
  assert.deepEqual(res2.codes, [200], "then exactly one 200");
  assert.equal(good.piped(), true, "and the body follows");
});
