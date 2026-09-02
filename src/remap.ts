import { linkSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { canonical } from "./seed.js";
import { gql } from "./suwayomi.js";
import { resolveManga } from "./match.js";
import { heldChapters } from "./held.js";

/**
 * Canonical chapter filename: "{Series} - c0070 [Group].cbz". Zero-padded so a plain
 * directory listing sorts correctly, and readable by any server if this project is
 * ever abandoned.
 */
export const chapterFilename = (title: string, num: string, scanlator: string | null): string => {
  const n = Number(num);
  const padded = Number.isInteger(n) ? String(n).padStart(4, "0") : n.toFixed(2).padStart(7, "0");
  const group = scanlator ? ` [${canonical(scanlator)}]` : "";
  return `${canonical(title)} - c${padded}${group}.cbz`;
};

type Legacy = { chapter_number: string; name: string | null; scanlator: string | null; page_count: number | null; uploaded_at: Date | null };

/**
 * Adopts files that are already on disk into a new source binding.
 *
 * This is the whole point of the project: the ledger is keyed on chapter number, so
 * a chapter we already hold satisfies the new binding without a single byte being
 * downloaded. Files are hardlinked rather than moved, so the legacy tree stays intact
 * and the operation is reversible until you delete it. Verified beforehand that the
 * CIFS share supports hardlinks; symlinks it does not.
 */
export async function remap(seriesId: number, opts: { dryRun?: boolean } = {}): Promise<void> {
  const p = db();
  const series = (await p.query<{ id: number; title: string; folder: string }>(
    "SELECT id, title, folder FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!series) throw new Error(`no series ${seriesId}`);

  const binding = (await p.query<{ id: number; source_id: string; source_name: string; source_manga_id: number; source_url: string | null }>(
    "SELECT id, source_id, source_name, source_manga_id, source_url FROM series_binding WHERE series_id = $1 AND role = 'active'",
    [seriesId])).rows[0];
  if (!binding) throw new Error(`series ${seriesId} has no primary binding`);

  // Suwayomi row ids do not survive the pod being replaced, so resolve the stable
  // (source, url) pair against whichever instance is answering now.
  const mangaId = binding.source_url
    ? await resolveManga(binding.source_id, series.title, binding.source_url)
    : binding.source_manga_id;

  const cand = (await p.query<{ folder: string; dead_source: string; suwayomi_manga_id: number | null }>(
    "SELECT folder, dead_source, suwayomi_manga_id FROM import_candidate WHERE confirmed_series_id = $1",
    [seriesId])).rows[0];
  if (!cand) throw new Error(`series ${seriesId} has no stranded folder to adopt from`);

  // What the new source offers. Primed first: a searched-but-never-opened manga has
  // a row and no chapter list.
  await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
    { id: mangaId }).catch(() => undefined);
  const target = await gql<{ manga: { chapters: { nodes: Array<{ chapterNumber: number | null }> } } }>(
    `{ manga(id:${mangaId}) { chapters { nodes { chapterNumber } } } }`);
  const offered = new Set(
    target.manga.chapters.nodes.map((c) => c.chapterNumber).filter((n): n is number => n !== null));

  // What we already hold, from heldChapters: the same function the review page uses to
  // say "you hold 44 chapters, 1-44".
  //
  // This used to run its own query against legacy_chapter gated on is_downloaded, and
  // that flag lies. On Noble in Name, Vulgar at Heart it was set on 1 of 44 rows while
  // all 44 files sat on disk, so a confirmed migration adopted one chapter and queued
  // the other 43 for re-download. Suwayomi's flag has been wrong in both directions
  // here, 157 chapters flagged with no file and 43 files it did not know about, which
  // is why heldChapters lets the filesystem decide and uses the snapshot only to
  // enrich. Two code paths disagreeing about what is on disk is how bytes get spent
  // twice, which is the one thing this project exists to prevent.
  const held = await heldChapters(cand.dead_source, cand.folder, cand.suwayomi_manga_id);
  const legacy: Legacy[] = [...held.entries()].sort((a, b) => a[0] - b[0]).map(([n, h]) => ({
    chapter_number: String(n),
    // Already the exact on-disk stem, so it must not be sanitized again.
    name: h.file.replace(/\.cbz$/i, ""),
    scanlator: h.scanlator, page_count: h.pageCount, uploaded_at: h.uploadedAt,
  }));

  const targetDir = `${config.libraryRoot}/${series.folder}`;
  let adopted = 0, absent = 0, alreadyThere = 0, notOffered = 0;

  for (const c of legacy) {
    const src = `${config.legacyRoot}/${cand.dead_source}/${cand.folder}/${c.name ?? ""}.cbz`;
    if (!existsSync(src)) { absent++; continue; }          // Suwayomi's flag lied again
    if (!offered.has(Number(c.chapter_number))) { notOffered++; }

    const dest = `${targetDir}/${chapterFilename(series.title, c.chapter_number, c.scanlator)}`;
    if (opts.dryRun) { adopted++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) linkSync(src, dest);
    const r = await p.query(
      `INSERT INTO chapter (series_id, chapter_number, file_path, page_count, scanlator, binding_id, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (series_id, chapter_number) DO NOTHING`,
      [seriesId, c.chapter_number, dest, c.page_count, c.scanlator, binding.id, c.uploaded_at]);
    if (r.rowCount === 0) alreadyThere++; else adopted++;
  }

  const toFetch = [...offered].filter((n) => !held.has(n)).sort((a, b) => a - b);

  console.log(`${opts.dryRun ? "[dry run] " : ""}${series.title}`);
  console.log(`  adopted from disk      ${adopted}${alreadyThere ? ` (${alreadyThere} already in ledger)` : ""}`);
  console.log(`  files Suwayomi lied about ${absent}`);
  console.log(`  held but not offered by the new source ${notOffered}`);
  console.log(`  genuinely new, to download ${toFetch.length}${toFetch.length ? ` -> ${toFetch.slice(0, 10).join(", ")}${toFetch.length > 10 ? " ..." : ""}` : ""}`);
}
