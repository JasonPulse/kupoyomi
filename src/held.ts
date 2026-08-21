import { statSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { scanLegacyTree } from "./disk.js";
import { parseChapterNumber } from "./chapternum.js";

/**
 * The chapter numbers we actually hold for a stranded folder.
 *
 * The snapshot is authoritative where it has a row; otherwise the numbers are read
 * from the filenames. Where several files claim one number the largest wins, since
 * the ledger allows exactly one file per chapter number.
 */
export async function heldChapterNumbers(
  deadSource: string, folder: string, suwayomiMangaId: number | null,
): Promise<number[]> {
  if (suwayomiMangaId !== null) {
    const rows = (await db().query<{ chapter_number: string }>(
      `SELECT DISTINCT chapter_number FROM legacy_chapter
        WHERE suwayomi_manga_id = $1 AND is_downloaded AND chapter_number IS NOT NULL`,
      [suwayomiMangaId])).rows;
    if (rows.length > 0) return rows.map((r) => Number(r.chapter_number)).sort((a, b) => a - b);
  }
  const entry = (await scanLegacyTree()).find((d) => d.sourceDir === deadSource && d.folder === folder);
  const best = new Map<number, number>();
  for (const f of entry?.files ?? []) {
    const n = parseChapterNumber(f);
    if (n === null) continue;
    const size = statSync(`${config.legacyRoot}/${deadSource}/${folder}/${f}`).size;
    if ((best.get(n) ?? 0) < size) best.set(n, size);
  }
  return [...best.keys()].sort((a, b) => a - b);
}

/** Trims the trailing zeros Postgres numerics render with: 30.3000 -> 30.3 */
export const fmt = (n: number | string | null): string => {
  if (n === null) return "-";
  const v = Number(n);
  return Number.isFinite(v) ? String(Number(v.toFixed(4))) : "-";
};
