import { db } from "./db.js";
import { gql } from "./suwayomi.js";
import type { Candidate } from "./match.js";

/**
 * Records the stable source url for candidates that were staged before bindings
 * keyed on it. Run against the Suwayomi that produced the ids -- 25 lookups rather
 * than re-searching 20 sources for 24 series.
 */
export async function backfillUrls(): Promise<void> {
  const p = db();
  const rows = (await p.query<{ id: number; candidates: Candidate[] }>(
    "SELECT id, candidates FROM import_candidate")).rows;
  let filled = 0, failed = 0;

  for (const r of rows) {
    let changed = false;
    for (const c of r.candidates) {
      if (c.url) continue;
      try {
        const d = await gql<{ manga: { url: string } }>(`{ manga(id:${c.mangaId}) { url } }`);
        c.url = d.manga.url;
        changed = true; filled++;
      } catch { failed++; }
    }
    if (changed) {
      await p.query("UPDATE import_candidate SET candidates = $1 WHERE id = $2", [JSON.stringify(r.candidates), r.id]);
    }
  }

  // Bindings already confirmed against those ids get the same treatment.
  const bound = (await p.query<{ id: number; source_manga_id: number }>(
    "SELECT id, source_manga_id FROM series_binding WHERE source_url IS NULL")).rows;
  let bindings = 0;
  for (const b of bound) {
    try {
      const d = await gql<{ manga: { url: string } }>(`{ manga(id:${b.source_manga_id}) { url } }`);
      await p.query("UPDATE series_binding SET source_url = $1 WHERE id = $2", [d.manga.url, b.id]);
      bindings++;
    } catch { /* a binding whose id is already gone must be re-confirmed by hand */ }
  }
  console.log(`backfilled ${filled} candidate urls (${failed} unresolvable), ${bindings} of ${bound.length} bindings`);
}
