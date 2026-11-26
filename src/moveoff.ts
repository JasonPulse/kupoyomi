import { db } from "./db.js";
import { usableSources } from "./paid.js";
import { searchEach } from "./searchall.js";
import { queryVariants } from "./match.js";
import { norm, aliasesFor } from "./adopt.js";
import { mangaDetail } from "./ui/searchstream.js";
import { addSeries } from "./ui/search.js";
import { resyncAfterSwitch } from "./sources.js";
import { readingList } from "./chapters.js";

/**
 * Moving every series off one source at once.
 *
 * When a host dies it takes all of its series with it, and the only way out was the
 * series page: search, compare, switch, once per series. Bbato going took seven series in
 * one go. This finds a replacement for each of them in the background, and the page lets
 * a person pick per series and switch them all in one submit.
 *
 * It never switches on its own. Identity and sources are a human's call in this project,
 * and two sites listing the same title can number its chapters differently. The pick is
 * cheap because nothing downloads twice: the ledger is keyed on chapter number, so the
 * new source only fills what is not already on disk.
 */
export type Replacement = {
  sourceId: string; sourceName: string; mangaId: number; title: string; url: string;
  chapters: number; highest: number | null; lastUpload: string | null;
  newBeyond: number; fillsGaps: number; notCarried: number;
};
export type Leaving = {
  seriesId: number; title: string; held: number;
  state: "waiting" | "searching" | "done" | "moved";
  candidates: Replacement[];
  movedTo?: string;
};
export type MoveJob = {
  sourceId: string; sourceName: string; startedAt: string; finishedAt?: string; series: Leaving[];
  error?: string;
};

/** Kept in memory like the metadata refresh: a restart loses it, and running it again is a button. */
const jobs = new Map<string, MoveJob>();
export const moveOffJob = (sourceId: string): MoveJob | undefined => jobs.get(sourceId);

/**
 * Series whose one source is this one.
 *
 * The id is a bigserial, which pg returns as a string. Left as one, the picks posted
 * from the move page (numbers, parsed from the form) never matched a series, and every
 * submit switched nothing.
 */
export const seriesOn = async (sourceId: string): Promise<Array<{ id: number; title: string; held: number }>> =>
  (await db().query<{ id: string; title: string; nums: number[] }>(
    `SELECT s.id, s.title,
            ARRAY(SELECT c.chapter_number::float8 FROM chapter c WHERE c.series_id = s.id) AS nums
       FROM series_binding b JOIN series s ON s.id = b.series_id
      WHERE b.role = 'active' AND b.source_id = $1 ORDER BY s.title`, [sourceId])).rows
    .map((r) => ({ id: Number(r.id), title: r.title, held: readingList(r.nums).length }));

/**
 * Every other usable source that lists this exact title, with what each would give.
 *
 * Exact after normalising case and punctuation, against the title and its aliases, the
 * same comparison aliases are matched with. Never fuzzy: a near title is a different
 * work often enough that guessing here is how a series gets bound to the wrong one.
 */
async function replacementsFor(
  s: { id: number; title: string }, pool: Awaited<ReturnType<typeof usableSources>>,
): Promise<Replacement[]> {
  const aliases = (await aliasesFor(s.id)).map((a) => a.alias);
  const wanted = new Set([s.title, ...aliases].map(norm));
  // A long title is often only findable by its head, so a few query forms, and each one
  // only asks the sources that have not matched yet.
  const queries = [...new Set([...queryVariants(s.title).slice(0, 3), ...aliases])].slice(0, 4);
  const hits: Array<{ src: (typeof pool)[number]; id: number; title: string; url: string }> = [];
  let pending = pool;
  for (const q of queries) {
    if (pending.length === 0) break;
    const matched = new Set<string>();
    await searchEach(pending, q, 10, (src, found) => {
      for (const m of found ?? []) {
        if (!wanted.has(norm(m.title))) continue;
        hits.push({ src, id: m.id, title: m.title, url: m.url });
        matched.add(src.id);
      }
    });
    pending = pending.filter((p) => !matched.has(p.id));
  }

  const out: Replacement[] = [];
  for (const h of hits) {
    try {
      const d = await mangaDetail(h.id, s.id);
      if (d.chapters === 0) continue;          // listed, but nothing to read there
      out.push({
        sourceId: h.src.id, sourceName: h.src.displayName, mangaId: h.id, title: h.title, url: h.url,
        chapters: d.chapters, highest: d.highest, lastUpload: d.lastUpload,
        newBeyond: d.newBeyond ?? 0, fillsGaps: d.fillsGaps ?? 0, notCarried: d.notCarried ?? 0,
      });
    } catch { /* a candidate that will not open is not a candidate */ }
  }
  // Furthest along first: a replacement is for the chapters still to come. Ties go to the
  // one that leaves fewer of yours uncarried, then to the longer list.
  return out.sort((a, b) => (b.highest ?? -1) - (a.highest ?? -1)
    || a.notCarried - b.notCarried || b.chapters - a.chapters);
}

/** Starts the search for every series on a source. Asking again while it runs returns the running job. */
export async function startMoveOff(sourceId: string): Promise<MoveJob> {
  const running = jobs.get(sourceId);
  if (running && !running.finishedAt) return running;

  const series = await seriesOn(sourceId);
  const name = (await db().query<{ source_name: string }>(
    "SELECT source_name FROM series_binding WHERE source_id = $1 LIMIT 1", [sourceId])).rows[0]?.source_name ?? sourceId;
  const job: MoveJob = {
    sourceId, sourceName: name, startedAt: new Date().toISOString(),
    series: series.map((s) => ({ seriesId: s.id, title: s.title, held: s.held, state: "waiting", candidates: [] })),
  };
  jobs.set(sourceId, job);

  void (async () => {
    try {
      // Not the source being left, and not any other host the probe has seen fail: offering
      // one dead source as the way off another is no help.
      const down = new Set((await db().query<{ source_id: string }>(
        "SELECT source_id FROM source_status WHERE failures > 0")).rows.map((r) => r.source_id));
      const pool = (await usableSources()).filter((s) => s.id !== sourceId && !down.has(s.id));
      // One series at a time. Each is already a search across every source, and running
      // seven of those at once is the kind of burst that gets an address banned.
      for (const l of job.series) {
        l.state = "searching";
        try {
          l.candidates = await replacementsFor({ id: l.seriesId, title: l.title }, pool);
        } catch (e) {
          console.log(`move off ${name}: ${l.title}: ${e instanceof Error ? e.message : String(e)}`);
        }
        l.state = "done";
      }
      console.log(`move off ${name}: ${job.series.filter((l) => l.candidates.length > 0).length} of ` +
        `${job.series.length} series have a replacement`);
    } catch (e) {
      // Finished either way. A job that never finishes is a page refreshing itself forever.
      job.error = e instanceof Error ? e.message : String(e);
      for (const l of job.series) if (l.state !== "moved") l.state = "done";
      console.log(`move off ${name} failed: ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
  return job;
}

/**
 * Switches each series to the replacement picked for it. A series with no pick stays
 * where it is. Returns how many moved.
 */
export async function applyMoveOff(sourceId: string, picks: Map<number, number>): Promise<number> {
  const job = jobs.get(sourceId);
  if (!job) throw new Error("no replacements found yet for this source; run the search first");
  let moved = 0;
  for (const l of job.series) {
    const r = l.candidates[picks.get(l.seriesId) ?? -1];
    if (!r || l.state === "moved") continue;
    await addSeries({ title: l.title, sourceId: r.sourceId, sourceName: r.sourceName, url: r.url, seriesId: l.seriesId });
    resyncAfterSwitch(l.seriesId);
    l.state = "moved";
    l.movedTo = r.sourceName;
    moved++;
  }
  return moved;
}
