import { db } from "./db.js";

/**
 * Making a source the one a series uses.
 *
 * Written three times over: adding from the migrate page, confirming an import, and the
 * button on the series page. Each did the same two statements in the same order, and the
 * ordering matters because one active source per series is a unique index, so the
 * incumbent has to step down before the replacement can stand up.
 *
 * Takes a client so a caller already inside a transaction stays inside it.
 */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function useSource(
  q: Queryable, seriesId: number,
  source: { sourceId: string; sourceName: string; url: string | null; mangaId?: number },
): Promise<void> {
  await q.query(
    "UPDATE series_binding SET role = 'former' WHERE series_id = $1 AND role = 'active'",
    [seriesId]);
  await q.query(
    `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, source_url, role)
     VALUES ($1,$2,$3,$4,$5,'active')
     ON CONFLICT (series_id, source_id, source_manga_id)
       DO UPDATE SET source_url = EXCLUDED.source_url, role = 'active'`,
    [seriesId, source.sourceId, source.sourceName, source.mangaId ?? 0, source.url]);
}

/**
 * What has to happen after a series changes source, beyond the row itself.
 *
 * A switch with no rescan behind it changes a binding and nothing else: the queue still
 * reflects the source that just stepped down. And a source has real cover art, which
 * beats a page picked out of a chapter.
 *
 * Deliberately not awaited by callers: both are live requests to a site, and the page
 * should come back at once rather than sitting on a search.
 */
export function resyncAfterSwitch(seriesId: number): void {
  void (async () => {
    const [{ scanWanted }, { refreshMetadata }] = await Promise.all([
      import("./fetch.js"), import("./metadata.js"),
    ]);
    await scanWanted({ seriesId }).catch((e: unknown) =>
      console.log(`rescan of series ${seriesId} failed: ${e instanceof Error ? e.message : String(e)}`));
    await refreshMetadata(seriesId, { force: true }).catch(() => undefined);
  })();
}
