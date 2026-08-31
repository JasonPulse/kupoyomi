import { db } from "./db.js";

export type SourceHealth = {
  sourceName: string;
  done: number;
  failed: number;
  attempts: number;
  /** Share of attempts that produced a chapter. Null until there is enough history. */
  landed: number | null;
};

/**
 * How reliably each source actually delivers, measured from what it has already been
 * asked for rather than from anything it advertises.
 *
 * One number does the work: the share of attempts that ended in a chapter on disk. A
 * source that needs two tries per chapter scores 0.5, and it does not matter whether it
 * got there by timing out, by returning a 500 on page three, or by giving up entirely.
 * Comic Asura sat at 0.542 while nine of the other twelve sources were at 1.000, and it
 * held 15 of the 17 outright failures in the library.
 */
export const MIN_SAMPLE = 15;

export async function sourceHealth(): Promise<SourceHealth[]> {
  const rows = (await db().query<{
    source_name: string; done: string; failed: string; attempts: string;
  }>(
    `SELECT b.source_name,
            count(*) FILTER (WHERE w.state = 'done')   AS done,
            count(*) FILTER (WHERE w.state = 'failed') AS failed,
            COALESCE(sum(w.attempts), 0)               AS attempts
       FROM wanted w JOIN series_binding b ON b.id = w.binding_id
      GROUP BY b.source_name`)).rows;

  return rows.map((r) => {
    const done = Number(r.done), failed = Number(r.failed), attempts = Number(r.attempts);
    // Too small a sample says nothing. A source three chapters into its first series
    // that hit one blip would otherwise be ranked below a proven bad one.
    return { sourceName: r.source_name, done, failed, attempts,
      landed: attempts >= MIN_SAMPLE ? done / attempts : null };
  }).sort((a, b) => (a.landed ?? 2) - (b.landed ?? 2));
}

/** Name to landed share, for the pages that rank sources. Unmeasured sources are absent. */
export async function healthMap(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const h of await sourceHealth()) if (h.landed !== null) out[h.sourceName] = h.landed;
  return out;
}
