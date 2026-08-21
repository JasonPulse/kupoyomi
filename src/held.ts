import { statSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { scanLegacyTree } from "./disk.js";
import { parseChapterNumber } from "./chapternum.js";
import { sanitize } from "./suwayomi.js";

export type Held = { file: string; scanlator: string | null; pageCount: number | null; uploadedAt: Date | null };

/**
 * What we actually hold for a stranded folder, as chapter number to the file on disk.
 *
 * The snapshot is authoritative where it has a row; otherwise numbers are read from
 * the filenames. Where several files claim one number the largest wins, since the
 * ledger allows exactly one file per chapter number.
 */
export async function heldChapters(
  deadSource: string, folder: string, suwayomiMangaId: number | null,
): Promise<Map<number, Held>> {
  const out = new Map<number, Held>();
  const dir = `${config.legacyRoot}/${deadSource}/${folder}`;

  if (suwayomiMangaId !== null) {
    const rows = (await db().query<{ chapter_number: string; name: string | null; scanlator: string | null; page_count: number | null; uploaded_at: Date | null }>(
      `SELECT chapter_number, name, scanlator, page_count, uploaded_at FROM legacy_chapter
        WHERE suwayomi_manga_id = $1 AND is_downloaded AND chapter_number IS NOT NULL
        ORDER BY chapter_number`, [suwayomiMangaId])).rows;
    for (const r of rows) {
      const base = r.scanlator ? `${sanitize(r.scanlator)}_${sanitize(r.name ?? "")}` : sanitize(r.name ?? "");
      const file = `${base}.cbz`;
      if (!existsSync(`${dir}/${file}`)) continue;        // Suwayomi's flag drifts
      out.set(Number(r.chapter_number), {
        file, scanlator: r.scanlator, pageCount: r.page_count, uploadedAt: r.uploaded_at,
      });
    }
    if (out.size > 0) return out;
  }

  const entry = (await scanLegacyTree()).find((d) => d.sourceDir === deadSource && d.folder === folder);
  const sizes = new Map<number, number>();
  for (const f of entry?.files ?? []) {
    const n = parseChapterNumber(f);
    if (n === null) continue;
    const size = statSync(`${dir}/${f}`).size;
    if ((sizes.get(n) ?? 0) < size) {
      sizes.set(n, size);
      out.set(n, { file: f, scanlator: null, pageCount: null, uploadedAt: null });
    }
  }
  return out;
}

/** Just the numbers, for callers that only need the shape of what is held. */
export const heldChapterNumbers = async (
  deadSource: string, folder: string, suwayomiMangaId: number | null,
): Promise<number[]> => [...(await heldChapters(deadSource, folder, suwayomiMangaId)).keys()].sort((a, b) => a - b);

/** Trims the trailing zeros Postgres numerics render with: 30.3000 -> 30.3 */
export const fmt = (n: number | string | null): string => {
  if (n === null) return "-";
  const v = Number(n);
  return Number.isFinite(v) ? String(Number(v.toFixed(4))) : "-";
};

/** "2026-05-10 (3mo ago)". Freshness is the point: a source that stopped publishing
 *  a year ago is a different proposition from one that posted last week. */
export const ago = (date: string | null, today: string): string => {
  if (!date) return "-";
  const d = String(date).slice(0, 10);
  const days = Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
  if (!Number.isFinite(days)) return d;
  const rel = days < 1 ? "today" : days < 14 ? `${days}d ago`
    : days < 60 ? `${Math.round(days / 7)}w ago`
    : days < 730 ? `${Math.round(days / 30)}mo ago`
    : `${(days / 365).toFixed(1)}y ago`;
  return `${d} (${rel})`;
};
