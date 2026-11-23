import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A source whose host has gone, end to end, against a stand-in Suwayomi.
 *
 * Bbato moved domains: its popular list and search came back empty, and its page proxy
 * answered 200 with zero bytes. Every path that reacts to that writes rows or files, so
 * none of it can be proven against the live library. The stand-in answers the handful of
 * GraphQL shapes these paths send and nothing else.
 */
const root = mkdtempSync(join(tmpdir(), "kupo-hosts-"));
process.env["LEGACY_ROOT"] = root;
process.env["LIBRARY_ROOT"] = join(root, "Library");
process.env["DATABASE_URL"] = process.env["TEST_DATABASE_URL"]
  ?? "postgres://postgres:test@127.0.0.1:55444/kupoyomi";

const DEAD = "hosts-test-dead", LIVE = "hosts-test-live", NEAR = "hosts-test-near";
const TITLE = "Hosts Test Series: The Long Subtitle";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

// What the stand-in says. Tests flip these.
const answering = new Map<string, boolean>([[DEAD, false], [LIVE, true], [NEAR, true]]);
let pageBody = Buffer.alloc(0);
const notified: Array<{ title: string; body: string }> = [];

const reply = (query: string, vars: Record<string, unknown>): unknown => {
  const src = String(vars["src"] ?? "");
  if (query.includes("type:POPULAR")) {
    return { fetchSourceManga: { mangas: answering.get(src) ? [{ id: 1 }] : [] } };
  }
  if (query.includes("fetchSourceManga")) {
    if (!answering.get(src)) return { fetchSourceManga: { mangas: [] } };
    // The near source lists a different work with a similar name, which must not match.
    const title = src === NEAR ? `${TITLE} (Novel)` : src === LIVE ? TITLE.toUpperCase() : TITLE;
    const id = src === DEAD ? 70 : src === LIVE ? 71 : 72;
    return { fetchSourceManga: { mangas: [{ id, title, url: `/m/${src}`, thumbnailUrl: null }] } };
  }
  if (query.includes("{ sources {")) {
    return { sources: { nodes: [DEAD, LIVE, NEAR].map((id) => ({
      id, displayName: id, lang: "en", isNsfw: false, supportsLatest: false })) } };
  }
  if (query.includes("fetchMangaAndChapters")) return { fetchMangaAndChapters: { clientMutationId: null } };
  if (query.includes("fetchChapterPages")) {
    return { fetchChapterPages: { pages: ["/api/v1/manga/70/chapter/700/page/0"] } };
  }
  if (query.includes("description status genre")) {
    return { manga: { description: null, status: "ONGOING", genre: [], chapters: { totalCount: 3,
      nodes: [1, 2, 3].map((n) => ({ chapterNumber: n, uploadDate: null })) } } };
  }
  if (query.includes("chapters { nodes")) {
    return { manga: { chapters: { nodes: [{ id: 700, chapterNumber: 5, name: "Ch 5", scanlator: null, uploadDate: null }] } } };
  }
  return {};
};

let fake: Server, sink: Server;
const listen = (s: Server): Promise<number> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

fake = createServer((req, res) => {
  if (req.url?.startsWith("/api/v1/manga/")) {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(pageBody);
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const { query, variables } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: reply(query, variables ?? {}) }));
  });
});
sink = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => { notified.push(JSON.parse(body)); res.end("ok"); });
});
process.env["SUWAYOMI_URL"] = `http://127.0.0.1:${await listen(fake)}/api/graphql`;
process.env["NOTIFY_URL"] = `http://127.0.0.1:${await listen(sink)}/notify`;

const { db, migrate, closeDb } = await import("../src/db.js");
const { checkSources } = await import("../src/schedule.js");
const { fetchWanted } = await import("../src/fetch.js");
const { getSeries, listSeries, getChapters, getPages, getPage } = await import("../src/pbapi.js");
const { buildCbz } = await import("../src/cbz.js");
const { startMoveOff, moveOffJob, applyMoveOff } = await import("../src/moveoff.js");

let haveDb = false;
try { await db().query("SELECT 1"); haveDb = true; } catch {
  console.log("no database reachable, skipping the dead host test");
}

let seriesId = 0;
const ours = () => notified.filter((n) => n.title.includes(DEAD));

before(async () => {
  if (!haveDb) return;
  await migrate();
  const p = db();
  await p.query("DELETE FROM series WHERE title = $1", [TITLE]);
  await p.query("DELETE FROM source_status WHERE source_id = ANY($1)", [[DEAD, LIVE, NEAR]]);
  seriesId = (await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$1) RETURNING id", [TITLE])).rows[0]!.id;
  await p.query(
    `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, source_url, role)
     VALUES ($1,$2,$2,0,$3,'active')`, [seriesId, DEAD, `/m/${DEAD}`]);
});

after(async () => {
  if (haveDb) await db().query("DELETE FROM series WHERE title = $1", [TITLE]);
  // The switch starts a rescan it does not wait for. Let it land before the pool closes.
  await new Promise((r) => setTimeout(r, 500));
  await closeDb();
  fake.close(); sink.close();
});

test("a host is alerted once when it goes down and once when it comes back", { skip: !haveDb }, async () => {
  await checkSources();
  assert.equal(ours().length, 0, "one failed probe is a blip, not an outage");

  await checkSources();
  assert.equal(ours().length, 1);
  assert.match(ours()[0]!.title, /unreachable/);
  assert.match(ours()[0]!.body, new RegExp(TITLE.slice(0, 20)), "the alert names the series affected");

  await checkSources();
  assert.equal(ours().length, 1, "still down is not news");

  answering.set(DEAD, true);
  await checkSources();
  assert.equal(ours().length, 2);
  assert.match(ours()[1]!.title, /is back/);
  const row = (await db().query<{ failures: number; alerted_at: string | null; down_since: string | null }>(
    "SELECT failures, alerted_at, down_since FROM source_status WHERE source_id = $1", [DEAD])).rows[0]!;
  assert.deepEqual(row, { failures: 0, alerted_at: null, down_since: null });
  answering.set(DEAD, false);
});

test("a 200 with no image in it is a failed page, not a chapter", { skip: !haveDb }, async () => {
  const p = db();
  answering.set(DEAD, true);         // search must find the url so the fetch gets as far as the pages
  await p.query("INSERT INTO wanted (series_id, chapter_number, binding_id) SELECT $1, 5, id FROM series_binding WHERE series_id = $1",
    [seriesId]);

  pageBody = Buffer.alloc(0);
  await fetchWanted({ only: { seriesId, chapter: "5" } });
  const w = (await p.query<{ state: string; last_error: string }>(
    "SELECT state, last_error FROM wanted WHERE series_id = $1 AND chapter_number = 5", [seriesId])).rows[0]!;
  assert.equal(w.state, "failed");
  assert.match(w.last_error, /0 bytes that are not an image/);
  assert.equal((await p.query("SELECT 1 FROM chapter WHERE series_id = $1", [seriesId])).rowCount, 0,
    "nothing is recorded as held");
  const dir = join(root, "Library", TITLE);
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, "no archive is written");

  // The guard must not refuse a real page.
  pageBody = PNG;
  await p.query("UPDATE wanted SET retry_after = NULL WHERE series_id = $1", [seriesId]);
  await fetchWanted({ only: { seriesId, chapter: "5" } });
  assert.equal((await p.query("SELECT 1 FROM chapter WHERE series_id = $1 AND chapter_number = 5", [seriesId])).rowCount, 1);
  answering.set(DEAD, false);
});

test("Paperback counts chapters, not files", { skip: !haveDb }, async () => {
  const p = db();
  for (const n of ["1", "1.1", "1.2", "1.5", "2"]) {
    await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,'/x') ON CONFLICT DO NOTHING",
      [seriesId, n]);
  }
  // 1, 1.1, 1.2, 1.5, 2 and the 5 from the test above: chapters 1, 2 and 5.
  assert.equal((await getSeries(seriesId))!.chapters, 3);
  assert.equal((await listSeries(TITLE.slice(0, 18))).find((s) => s.id === String(seriesId))!.chapters, 3);
  assert.deepEqual((await getChapters(seriesId)).map((c) => c.id), ["5.0000", "2.0000", "1.0000"]);
});

test("a chapter held only as parts reads as one chapter, every page in order", { skip: !haveDb }, async () => {
  const p = db();
  const page = (tag: number) => Buffer.concat([PNG, Buffer.from([tag])]);
  for (const [n, count] of [[7.1, 2], [7.2, 3]] as const) {
    const path = join(root, `part-${n}.cbz`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, buildCbz(Array.from({ length: count }, (_, i) => ({
      name: `${String(i + 1).padStart(3, "0")}.png`, data: page(n * 10 + i) })), new Date(0)));
    await p.query("INSERT INTO chapter (series_id, chapter_number, file_path) VALUES ($1,$2,$3)", [seriesId, n, path]);
  }
  const seven = (await getChapters(seriesId)).find((c) => c.number === 7);
  assert.ok(seven, "listed once, as chapter 7");
  assert.equal((await getChapters(seriesId)).filter((c) => Math.trunc(c.number) === 7).length, 1);
  assert.equal((await getPages(seriesId, "7.0000"))!.length, 5);
  // Page 3 of the chapter is the second file's second page.
  assert.deepEqual((await getPage(seriesId, "7.0000", 3))!.body, page(72 + 1));
  // An id Paperback cached before parts were folded still opens that file.
  assert.equal((await getPages(seriesId, "7.2000"))!.length, 3);
});

test("moving off a dead source offers exact titles only, and switches only what was picked", { skip: !haveDb }, async () => {
  await startMoveOff(DEAD);
  for (let i = 0; i < 100 && !moveOffJob(DEAD)?.finishedAt; i++) await new Promise((r) => setTimeout(r, 50));
  const job = moveOffJob(DEAD)!;
  assert.ok(job.finishedAt, "the search finished");
  const l = job.series.find((s) => s.seriesId === seriesId)!;
  // LIVE lists the title in capitals and counts as exact. NEAR lists "(Novel)", a
  // different work. DEAD is the source being left and is never offered back.
  assert.deepEqual(l.candidates.map((c) => c.sourceId), [LIVE]);

  // Staying put is a pick too.
  assert.equal(await applyMoveOff(DEAD, new Map([[seriesId, -1]])), 0);
  assert.equal(await applyMoveOff(DEAD, new Map([[seriesId, 0]])), 1);
  const roles = (await db().query<{ source_id: string; role: string }>(
    "SELECT source_id, role FROM series_binding WHERE series_id = $1 ORDER BY source_id", [seriesId])).rows;
  assert.deepEqual(roles, [{ source_id: DEAD, role: "former" }, { source_id: LIVE, role: "active" }]);
  assert.ok((await db().query("SELECT 1 FROM chapter WHERE series_id = $1", [seriesId])).rowCount! > 0,
    "files already held stay in the ledger");
});
