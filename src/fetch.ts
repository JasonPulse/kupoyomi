import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { gql } from "./suwayomi.js";
import { resolveManga } from "./match.js";
import { buildCbz, comicInfo } from "./cbz.js";
import { chapterFilename } from "./remap.js";

/** Suwayomi's page proxy lives beside the graphql endpoint. */
const httpBase = (): string => config.suwayomiUrl.replace(/\/api\/graphql\/?$/, "");

type Binding = { id: number; series_id: number; source_id: string; source_name: string; source_url: string | null; title: string; folder: string };

/**
 * Records every chapter the bound source offers that the ledger does not hold.
 *
 * Cheap and idempotent, so it is safe to run on a schedule: it is how new releases get
 * noticed at all.
 */
export async function scanWanted(opts: { seriesId?: number } = {}): Promise<void> {
  const p = db();
  const bindings = (await p.query<Binding>(
    `SELECT b.id, b.series_id, b.source_id, b.source_name, b.source_url, s.title, s.folder
       FROM series_binding b JOIN series s ON s.id = b.series_id
      WHERE b.role = 'primary' AND NOT s.muted ${opts.seriesId ? "AND s.id = $1" : ""}
      ORDER BY s.title`, opts.seriesId ? [opts.seriesId] : [])).rows;

  let queued = 0, checked = 0;
  for (const b of bindings) {
    let mangaId: number;
    try {
      if (!b.source_url) continue;
      mangaId = await resolveManga(b.source_id, b.title, b.source_url);
      await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
        { id: mangaId });
    } catch (err) {
      console.log(`  ${b.title.slice(0, 40)}: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      continue;
    }
    const offered = (await gql<{ manga: { chapters: { nodes: Array<{ chapterNumber: number | null }> } } }>(
      `{ manga(id:${mangaId}) { chapters { nodes { chapterNumber } } } }`)).manga.chapters.nodes
      .map((c) => c.chapterNumber).filter((n): n is number => n !== null);
    const held = new Set((await p.query<{ chapter_number: string }>(
      "SELECT chapter_number FROM chapter WHERE series_id = $1", [b.series_id])).rows
      .map((r) => Number(r.chapter_number)));

    for (const n of offered) {
      if (held.has(n)) continue;
      const r = await p.query(
        `INSERT INTO wanted (series_id, chapter_number, binding_id) VALUES ($1,$2,$3)
         ON CONFLICT (series_id, chapter_number) DO NOTHING`, [b.series_id, n, b.id]);
      queued += r.rowCount ?? 0;
    }
    checked++;
  }
  const total = (await p.query<{ n: string }>("SELECT count(*) n FROM wanted WHERE state <> 'done'")).rows[0];
  console.log(`checked ${checked} of ${bindings.length} bindings, queued ${queued} new; ${total?.n ?? 0} outstanding`);
}

/**
 * Downloads queued chapters.
 *
 * One source at a time within a source, several sources in parallel: the same shape as
 * Suwayomi's own downloader (maxSourcesInParallel = 6, all manga of a source handled
 * synchronously). That grouping is why this library has never been IP-banned, and
 * bypassing Suwayomi's downloader means reproducing it rather than inheriting it.
 */
export async function fetchWanted(opts: { limit?: number; concurrency?: number } = {}): Promise<void> {
  const p = db();
  const concurrency = opts.concurrency ?? 6;
  const rows = (await p.query<{ series_id: number; chapter_number: string; binding_id: number; source_id: string; source_name: string; source_url: string | null; title: string; folder: string; attempts: number }>(
    `SELECT w.series_id, w.chapter_number, w.binding_id, b.source_id, b.source_name, b.source_url,
            s.title, s.folder, w.attempts
       FROM wanted w
       JOIN series_binding b ON b.id = w.binding_id
       JOIN series s ON s.id = w.series_id
      WHERE w.state IN ('pending','failed','fetching') AND w.attempts < 4
      ORDER BY s.title, w.chapter_number
      ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ""}`)).rows;
  if (rows.length === 0) { console.log("nothing queued"); return; }

  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    const l = bySource.get(r.source_id);
    if (l) l.push(r); else bySource.set(r.source_id, [r]);
  }
  console.log(`${rows.length} chapters across ${bySource.size} sources, ${concurrency} sources at a time`);

  let done = 0, failed = 0, bytes = 0;
  const queues = [...bySource.values()];
  const runSource = async (items: typeof rows): Promise<void> => {
    const resolved = new Map<number, number>();     // binding id -> local manga id
    for (const it of items) {
      try {
        let mangaId = resolved.get(it.binding_id);
        if (mangaId === undefined) {
          if (!it.source_url) throw new Error("binding has no source url");
          mangaId = await resolveManga(it.source_id, it.title, it.source_url);
          await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
            { id: mangaId }).catch(() => undefined);
          resolved.set(it.binding_id, mangaId);
        }
        const want = Number(it.chapter_number);
        const chapters = (await gql<{ manga: { chapters: { nodes: Array<{ id: number; chapterNumber: number | null; name: string | null; scanlator: string | null; uploadDate: string | null }> } } }>(
          `{ manga(id:${mangaId}) { chapters { nodes { id chapterNumber name scanlator uploadDate } } } }`)).manga.chapters.nodes;
        const ch = chapters.find((c) => c.chapterNumber === want);
        if (!ch) throw new Error(`source no longer lists chapter ${want}`);

        const pages = (await gql<{ fetchChapterPages: { pages: string[] } }>(
          `mutation($id:Int!){ fetchChapterPages(input:{chapterId:$id}){ pages } }`, { id: ch.id })).fetchChapterPages.pages;
        if (pages.length === 0) throw new Error("chapter has no pages");
        // Marked in flight with its page count, so the UI can show progress rather
        // than a chapter vanishing for a minute and reappearing done.
        await p.query(
          `UPDATE wanted SET state='fetching', started_at=now(), pages_done=0, pages_total=$3
            WHERE series_id=$1 AND chapter_number=$2`,
          [it.series_id, it.chapter_number, pages.length]);

        const images: Array<{ name: string; data: Buffer }> = [];
        for (const [i, rel] of pages.entries()) {
          const res = await fetch(`${httpBase()}${rel}`, {
            signal: AbortSignal.timeout(Number(process.env["PAGE_TIMEOUT_MS"] ?? 60_000)),
          });
          if (!res.ok) throw new Error(`page ${i} returned ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png"
            : (res.headers.get("content-type") ?? "").includes("webp") ? "webp" : "jpg";
          images.push({ name: `${String(i + 1).padStart(3, "0")}.${ext}`, data: buf });
          if (i % 3 === 2 || i === pages.length - 1) {
            await p.query("UPDATE wanted SET pages_done=$3 WHERE series_id=$1 AND chapter_number=$2",
              [it.series_id, it.chapter_number, i + 1]);
          }
        }

        const uploaded = ch.uploadDate ? new Date(Number(ch.uploadDate)) : null;
        const cbz = buildCbz([
          { name: "ComicInfo.xml", data: comicInfo({
              series: it.title, number: it.chapter_number, title: ch.name,
              scanlator: ch.scanlator, uploaded, pageCount: images.length }) },
          ...images,
        ], uploaded ?? new Date(0));

        const dest = `${config.libraryRoot}/${it.folder}/${chapterFilename(it.title, it.chapter_number, ch.scanlator)}`;
        mkdirSync(dirname(dest), { recursive: true });
        // Written to a temporary name and renamed, so a page failing part-way through
        // can never leave a truncated archive that later looks complete.
        const tmp = `${dest}.part`;
        writeFileSync(tmp, cbz);
        renameSync(tmp, dest);
        bytes += cbz.length;

        await p.query(
          `INSERT INTO chapter (series_id, chapter_number, file_path, page_count, scanlator, binding_id, uploaded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (series_id, chapter_number) DO UPDATE SET file_path = EXCLUDED.file_path`,
          [it.series_id, it.chapter_number, dest, images.length, ch.scanlator, it.binding_id, uploaded]);
        await p.query(
          "UPDATE wanted SET state='done', finished_at=now(), attempts=attempts+1, last_error=NULL WHERE series_id=$1 AND chapter_number=$2",
          [it.series_id, it.chapter_number]);
        done++;
        console.log(`  ok  ${it.title.slice(0, 34).padEnd(34)} ch ${it.chapter_number.padStart(8)}  ${images.length}p`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message.slice(0, 300) : String(err);
        await p.query(
          "UPDATE wanted SET state='failed', attempts=attempts+1, last_error=$3 WHERE series_id=$1 AND chapter_number=$2",
          [it.series_id, it.chapter_number, msg]);
        console.log(`  ERR ${it.title.slice(0, 34).padEnd(34)} ch ${it.chapter_number.padStart(8)}  ${msg.slice(0, 60)}`);
      }
    }
  };

  for (let i = 0; i < queues.length; i += concurrency) {
    await Promise.all(queues.slice(i, i + concurrency).map(runSource));
  }
  console.log(`\ndownloaded ${done}, failed ${failed}, ${(bytes / 1048576).toFixed(0)}MB`);
}
