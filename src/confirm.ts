import { db } from "./db.js";
import { compare } from "./match.js";
import { canonical } from "./seed.js";
import type { Candidate } from "./match.js";

type Row = {
  id: number; folder: string; dead_source: string | null; file_count: number;
  resolved_title: string | null; match_kind: string; candidates: Candidate[];
};

/**
 * Lists what needs a decision, with the numbers needed to make it: chapter count,
 * gaps, and the last few uploads per candidate source. Migration is never automatic,
 * so this is the whole point of the importer.
 */
export async function listCandidates(opts: { id?: number } = {}): Promise<void> {
  const rows = (await db().query<Row>(
    `SELECT id, folder, dead_source, file_count, resolved_title, match_kind, candidates
       FROM import_candidate
      WHERE confirmed_series_id IS NULL ${opts.id ? "AND id = $1" : ""}
      ORDER BY file_count DESC`, opts.id ? [opts.id] : [])).rows;

  if (rows.length === 0) { console.log("nothing awaiting confirmation"); return; }

  for (const r of rows) {
    const title = r.resolved_title ?? r.folder;
    console.log(`\n[${r.id}] ${title}`);
    console.log(`     ${r.file_count} files stranded under ${r.dead_source ?? "-"}`);
    if (r.candidates.length === 0) {
      console.log("     no exact-title match on any live source -- needs a manual search");
      continue;
    }
    for (const c of r.candidates) {
      const cmp = await compare(c.mangaId);
      const range = cmp.range ? `${cmp.range[0]}-${cmp.range[1]}` : "-";
      console.log(`     --pick ${String(c.mangaId).padEnd(6)} ${c.sourceName.padEnd(20)} ` +
        `chapters=${String(cmp.chapters).padStart(4)} range=${range} missing=${cmp.missing.length}`);
      for (const l of cmp.latest.slice(0, 3)) {
        console.log(`${" ".repeat(20)}ch ${String(l.chapter).padStart(7)}  ${l.uploaded}  ${l.scanlator ?? "-"}`);
      }
    }
  }
  console.log(`\n${rows.length} awaiting confirmation. Choose with:  kupoyomi confirm <id> --pick <mangaId>`);
}

/**
 * Binds a stranded folder to the source you chose. Creates the series identity once;
 * from here the ledger is keyed on chapter number and a later source change cannot
 * disturb it.
 */
export async function confirmCandidate(id: number, mangaId: number): Promise<void> {
  const p = db();
  const row = (await p.query<Row>(
    "SELECT id, folder, dead_source, file_count, resolved_title, match_kind, candidates FROM import_candidate WHERE id = $1",
    [id])).rows[0];
  if (!row) throw new Error(`no candidate ${id}`);
  const pick = row.candidates.find((c) => c.mangaId === mangaId);
  if (!pick) throw new Error(`candidate ${id} has no option with manga id ${mangaId}`);

  const title = pick.title || row.resolved_title || row.folder;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const s = await client.query<{ id: number }>(
      `INSERT INTO series (title, folder) VALUES ($1,$2)
       ON CONFLICT (folder) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
      [title, canonical(title)]);
    const seriesId = s.rows[0]!.id;
    await client.query(
      `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, role)
       VALUES ($1,$2,$3,$4,'primary')
       ON CONFLICT (series_id, source_id, source_manga_id) DO UPDATE SET role = 'primary'`,
      [seriesId, pick.sourceId, pick.sourceName, pick.mangaId]);
    await client.query("UPDATE import_candidate SET confirmed_series_id = $1 WHERE id = $2", [seriesId, id]);
    await client.query("COMMIT");
    console.log(`confirmed "${title}" -> ${pick.sourceName} (series ${seriesId})`);
    console.log(`  ${row.file_count} stranded files will be adopted, not re-downloaded, on the next remap`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
