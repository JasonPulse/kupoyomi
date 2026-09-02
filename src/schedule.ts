import { db } from "./db.js";
import { scanWanted, fetchWanted } from "./fetch.js";
import { refreshAllMetadata } from "./metadata.js";

const hours = (n: number): number => n * 3600_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export type SchedulerState = {
  /** Set while a job is in flight, so a wedged loop is visible rather than silent. */
  scanStartedAt?: string;
  fetchStartedAt?: string;
  lastScan?: { at: string; error?: string };
  lastFetch?: { at: string; downloaded: number; failed: number; error?: string };
  lastStallCheck?: { at: string; flagged: number };
  lastMetadata?: { at: string; error?: string };
  outstanding?: number;
};
export const state: SchedulerState = {};

/**
 * Separate locks per job. Sharing one meant a scan that hung on an unresponsive source
 * blocked every fetch tick behind it: downloads simply stopped and the only symptom was
 * an absent lastFetch. They touch different rows, so they do not need to exclude
 * each other.
 */
let scanning = false;
let fetching = false;
let metadata = false;

/**
 * Notifies once per event. A stalled series that keeps being stalled is not news, so
 * alerting on state rather than transition would train you to ignore it.
 */
async function notify(title: string, message: string): Promise<void> {
  const url = process.env["NOTIFY_URL"];
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body: message, message }),
    });
  } catch { /* a missed notification must never break the loop */ }
}

/**
 * Flags series whose bound source has gone quiet.
 *
 * Deliberately dumb: 21 days without a new chapter. Suwayomi's own status field only
 * knew the answer for 9 of 19 series and was wrong on at least one, so inferring
 * "finished" from metadata is not on. The flag prompts a human to look, which is the
 * only thing that can actually tell the difference between finished and abandoned.
 */
export async function checkStalled(): Promise<number> {
  const p = db();
  const days = num("STALL_DAYS", 21);

  // The first pass establishes a baseline and stays silent. "Went quiet" means it
  // changed while we were watching; on a library where 27 of 39 series were already
  // quiet before this existed, alerting on all of them at once is noise that teaches
  // you to ignore the channel.
  // A series the check no longer considers keeps whatever flag it was last given, and
  // nothing would ever revisit it. Clear those first, or excluding a series from the rule
  // leaves it labelled by a rule it is no longer subject to.
  const cleared = await p.query(
    `UPDATE series SET stalled_since = NULL, stall_alerted_at = NULL
      WHERE stalled_since IS NOT NULL AND (
        muted OR status = 'COMPLETED'
        OR NOT EXISTS (SELECT 1 FROM series_binding b
                        WHERE b.series_id = series.id AND b.role = 'active')
        OR COALESCE((SELECT max(c.uploaded_at) FROM chapter c WHERE c.series_id = series.id),
                    now()) < '1995-01-01')`);
  if ((cleared.rowCount ?? 0) > 0) {
    console.log(`  cleared the quiet flag on ${cleared.rowCount} series the rule no longer covers`);
  }

  const seen = (await p.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'stall_baseline_at'")).rows[0];
  const baselining = !seen;
  const rows = (await p.query<{ id: number; title: string; last: string | null; alerted: string | null }>(
    `SELECT s.id, s.title, max(c.uploaded_at)::text AS last, s.stall_alerted_at::text AS alerted
       FROM series s LEFT JOIN chapter c ON c.series_id = s.id
      WHERE NOT s.muted AND s.status <> 'COMPLETED'
        -- A source that reports no upload date gives us the epoch, and a series whose
        -- newest chapter looks like 1970 was flagged as dead when the truth is the source
        -- did not say. Saving 80,000 Gold was quiet for that reason alone.
        AND (c.uploaded_at IS NULL OR c.uploaded_at > '1995-01-01')
        -- Nothing is looking for chapters when nothing is bound, so silence is not
        -- evidence of anything. An imported folder is not a series that went quiet.
        AND EXISTS (SELECT 1 FROM series_binding b
                     WHERE b.series_id = s.id AND b.role = 'active')
      GROUP BY s.id, s.title, s.stall_alerted_at`)).rows;

  let flagged = 0;
  for (const r of rows) {
    if (!r.last) continue;
    const quiet = (Date.now() - Date.parse(r.last)) / 86400_000;
    if (quiet < days) {
      await p.query("UPDATE series SET stalled_since = NULL, stall_alerted_at = NULL WHERE id = $1 AND stalled_since IS NOT NULL", [r.id]);
      continue;
    }
    const upd = await p.query(
      "UPDATE series SET stalled_since = COALESCE(stalled_since, now()) WHERE id = $1 AND stalled_since IS NULL", [r.id]);
    if (baselining) {
      // Recorded as already-quiet, so it never produces a retrospective alert.
      await p.query("UPDATE series SET stall_alerted_at = now() WHERE id = $1", [r.id]);
      continue;
    }
    if ((upd.rowCount ?? 0) > 0 && !r.alerted) {
      await notify("Kupoyomi: series went quiet",
        `${r.title} has had no new chapter in ${Math.round(quiet)} days. Its source may have stopped carrying it.`);
      await p.query("UPDATE series SET stall_alerted_at = now() WHERE id = $1", [r.id]);
      flagged++;
    }
  }
  if (baselining) {
    await p.query("INSERT INTO settings (key, value) VALUES ('stall_baseline_at', now()::text) ON CONFLICT (key) DO NOTHING");
    const quiet = (await p.query<{ n: string }>("SELECT count(*) n FROM series WHERE stalled_since IS NOT NULL")).rows[0];
    console.log(`baseline established: ${quiet?.n ?? 0} series were already quiet, none alerted`);
  }
  return flagged;
}

/**
 * Keeps the library current on its own.
 *
 * Fetching is paced rather than raced: the backlog is not urgent, and the reason this
 * library has never been IP-banned is that Suwayomi's downloader never hammered a
 * source. A small batch on a long interval drains a thousand-chapter backlog in days
 * without ever looking like a scraper.
 */
export function startScheduler(): void {
  const scanEvery = hours(num("SCAN_INTERVAL_HOURS", 6));
  const fetchEvery = num("FETCH_INTERVAL_MINUTES", 15) * 60_000;
  const batch = num("FETCH_BATCH", 10);
  const concurrency = num("FETCH_CONCURRENCY", 2);

  void (async () => {
    for (;;) {
      try {
        if (!scanning) {
          scanning = true;
          state.scanStartedAt = new Date().toISOString();
          await scanWanted();
          state.lastScan = { at: new Date().toISOString() };
          delete state.scanStartedAt;
        }
      } catch (err) {
        state.lastScan = { at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
        delete state.scanStartedAt;
      } finally { scanning = false; }
      await sleep(scanEvery);
    }
  })();

  void (async () => {
    await sleep(20_000);                 // let the extension bootstrap settle first
    for (;;) {
      try {
        if (!fetching) {
          fetching = true;
          state.fetchStartedAt = new Date().toISOString();
          const done = (await db().query<{ n: string }>(
            "SELECT count(*) n FROM wanted WHERE state = 'done'")).rows[0];
          await fetchWanted({ limit: batch, concurrency });
          const after = (await db().query<{ d: string; o: string }>(
            `SELECT count(*) FILTER (WHERE state = 'done') AS d,
                    count(*) FILTER (WHERE state <> 'done') AS o FROM wanted`)).rows[0];
          state.outstanding = Number(after?.o ?? 0);
          state.lastFetch = { at: new Date().toISOString(),
            downloaded: Number(after?.d ?? 0) - Number(done?.n ?? 0), failed: 0 };
          delete state.fetchStartedAt;
        }
      } catch (err) {
        state.lastFetch = { at: new Date().toISOString(), downloaded: 0, failed: 0, error: err instanceof Error ? err.message : String(err) };
        delete state.fetchStartedAt;
      } finally { fetching = false; }
      await sleep(fetchEvery);
    }
  })();

  // Covers and synopses used to arrive only when someone remembered to run the command,
  // so a newly added series sat blank in the library and in Paperback until then. The
  // pass only touches series actually missing one, which is nothing most of the time.
  void (async () => {
    await sleep(60_000);                 // after the first scan, so new series are in
    for (;;) {
      try {
        if (!metadata) {
          metadata = true;
          await refreshAllMetadata({ limit: num("METADATA_BATCH", 20) });
          state.lastMetadata = { at: new Date().toISOString() };
        }
      } catch (err) {
        state.lastMetadata = { at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
      } finally { metadata = false; }
      await sleep(hours(num("METADATA_INTERVAL_HOURS", 6)));
    }
  })();

  void (async () => {
    for (;;) {
      try {
        const flagged = await checkStalled();
        state.lastStallCheck = { at: new Date().toISOString(), flagged };
      } catch { /* reported on the next pass */ }
      await sleep(hours(num("STALL_INTERVAL_HOURS", 24)));
    }
  })();

  console.log(`scheduler: scan every ${num("SCAN_INTERVAL_HOURS", 6)}h, ` +
    `fetch ${batch} chapters every ${num("FETCH_INTERVAL_MINUTES", 15)}m across ${concurrency} sources, ` +
    `stall check every ${num("STALL_INTERVAL_HOURS", 24)}h, ` +
    `metadata every ${num("METADATA_INTERVAL_HOURS", 6)}h`);
}
