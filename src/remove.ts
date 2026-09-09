import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { sanitize } from "./suwayomi.js";
import { dropMissingFiles } from "./prune.js";

export type RemovalPlan = {
  seriesId: number; title: string; folder: string;
  chapters: number; canonicalDir: string; canonicalFiles: number;
  /** Distinct bytes: files still linked elsewhere do not free space until that copy goes. */
  bytes: number; sharedFiles: number;
  /** Only folders proven to hold a hardlink to one of our chapters. */
  legacyDirs: Array<{ path: string; files: number }>;
  candidateId: number | null;
};

/**
 * Works out exactly what removing a series would delete, before anything is touched.
 *
 * Library files are hardlinks to the old Suwayomi tree for every adopted series, so
 * deleting the library copy alone reclaims nothing. The plan says which files are still
 * linked elsewhere and where those copies live, because "remove all files" cannot be
 * answered honestly without it.
 */
export async function planRemoval(seriesId: number): Promise<RemovalPlan> {
  const p = db();
  const s = (await p.query<{ id: number; title: string; folder: string }>(
    "SELECT id, title, folder FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!s) throw new Error(`no series ${seriesId}`);

  const rows = (await p.query<{ file_path: string }>(
    "SELECT file_path FROM chapter WHERE series_id = $1", [seriesId])).rows;
  const canonicalDir = `${config.libraryRoot}/${s.folder}`;

  let bytes = 0, shared = 0, present = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    try {
      const st = statSync(r.file_path);
      present++;
      if (st.nlink > 1) shared++;
      if (!seen.has(Number(st.ino))) { seen.add(Number(st.ino)); bytes += st.size; }
    } catch { /* already gone */ }
  }

  // Where the original copies live: the folder a migration adopted from, and each
  // binding's own per-source folder in the old tree.
  const cand = (await p.query<{ id: number; dead_source: string | null; folder: string }>(
    "SELECT id, dead_source, folder FROM import_candidate WHERE confirmed_series_id = $1", [seriesId])).rows[0];
  const bindings = (await p.query<{ source_name: string }>(
    "SELECT DISTINCT source_name FROM series_binding WHERE series_id = $1", [seriesId])).rows;

  const guesses = new Set<string>();
  if (cand?.dead_source) guesses.add(`${config.legacyRoot}/${cand.dead_source}/${cand.folder}`);
  for (const b of bindings) {
    guesses.add(`${config.legacyRoot}/${b.source_name}/${sanitize(s.title)}`);
    if (cand) guesses.add(`${config.legacyRoot}/${b.source_name}/${cand.folder}`);
  }

  // A path built from a source name and a sanitized title is a guess, and existing is
  // not proof: another series with a similar sanitized title would be deleted instead.
  // Our chapters are hardlinks, so a folder is only accepted when a file inside it
  // shares an inode with one of them. That is proof rather than inference.
  const ourInodes = new Set<number>();
  for (const r of rows) {
    try { ourInodes.add(Number(statSync(r.file_path).ino)); } catch { /* gone */ }
  }
  const legacyDirs: Array<{ path: string; files: number }> = [];
  for (const path of guesses) {
    if (!existsSync(path)) continue;
    const cbz = readdirSync(path).filter((f) => f.toLowerCase().endsWith(".cbz"));
    let linked = 0;
    for (const f of cbz) {
      try { if (ourInodes.has(Number(statSync(`${path}/${f}`).ino))) linked++; } catch { /* ignore */ }
    }
    if (linked > 0) legacyDirs.push({ path, files: cbz.length });
  }

  return {
    seriesId, title: s.title, folder: s.folder, chapters: rows.length,
    canonicalDir, canonicalFiles: present, bytes, sharedFiles: shared,
    legacyDirs, candidateId: cand?.id ?? null,
  };
}

/**
 * Deletes a directory tree and proves it is gone.
 *
 * rmSync unlinks every file and then removes the directory. On this CIFS share the
 * listing has not caught up by the time rmdir runs, so it fails with ENOTEMPTY on a
 * directory it has just emptied. Retried first, which is what maxRetries is for.
 *
 * A directory that survives is not cosmetic. Disk is the source of truth, so a folder
 * still on disk means the series is still on disk, and reporting success over it would
 * make the ledger the authority instead. rmSync has also returned successfully against
 * this share with the directory still present, so the result is checked rather than
 * trusted.
 */
export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  if (!existsSync(dir)) return;
  let left: string[] = [];
  try { left = readdirSync(dir); } catch { /* unreadable counts as still there */ }
  throw new Error(`${dir} is still on disk after removal, holding ${left.length} `
    + `${left.length === 1 ? "entry" : "entries"}`);
}

/**
 * Removes a series. The database rows go through the cascades; files only go if asked,
 * and the old tree only if asked separately, because that copy is the original.
 */
export async function removeSeries(
  seriesId: number, opts: { files?: boolean; legacy?: boolean } = {},
): Promise<{ deletedFiles: number; deletedDirs: string[]; rows: number }> {
  const plan = await planRemoval(seriesId);
  const deletedDirs: string[] = [];
  let deletedFiles = 0;

  // Whatever went has to be reflected before anything else can fail, because the ledger
  // saying it holds a file that is gone is the state this operation must never leave
  // behind. "The Inferior Magic Swordsman" lost 104 files to a failed rmdir and kept 104
  // rows, and the library reported chapters that were not there.
  const settle = async (err: unknown): Promise<never> => {
    const dropped = await dropMissingFiles(seriesId);
    throw new Error(`${err instanceof Error ? err.message : String(err)}. `
      + `${dropped} ledger rows for files that did go have been dropped, so the ledger `
      + `matches the disk. The series is kept because its folder is still there. `
      + `Removing it again will finish the job.`);
  };

  if (opts.files && existsSync(plan.canonicalDir)) {
    deletedFiles += readdirSync(plan.canonicalDir).length;
    try {
      removeTree(plan.canonicalDir);
      deletedDirs.push(plan.canonicalDir);
    } catch (err) { await settle(err); }
  }
  if (opts.legacy) {
    for (const d of plan.legacyDirs) {
      deletedFiles += d.files;
      try {
        removeTree(d.path);
        deletedDirs.push(d.path);
      } catch (err) { await settle(err); }
    }
  }

  const p = db();
  // chapter, series_binding, read_progress and wanted all cascade from series.
  const r = await p.query("DELETE FROM series WHERE id = $1", [seriesId]);
  // With the originals gone there is nothing left to migrate, so the candidate goes too;
  // if they remain it stays, and correctly reappears as unresolved.
  if (opts.legacy && plan.candidateId !== null) {
    await p.query("DELETE FROM import_candidate WHERE id = $1", [plan.candidateId]);
  }
  return { deletedFiles, deletedDirs, rows: r.rowCount ?? 0 };
}
