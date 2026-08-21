import { db } from "./db.js";
import { scanWanted, fetchWanted } from "./fetch.js";

const hours = (n: number): number => n * 3600_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export type SchedulerState = {
  lastScan?: { at: string; error?: string };
  lastFetch?: { at: string; downloaded: number; failed: number; error?: string };
  lastStallCheck?: { at: string; flagged: number };
  outstanding?: number;
};
export const state: SchedulerState = {};

/** Only one of these runs at a time, so a manual command cannot collide with the loop. */
let busy = false;

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
  const rows = (await p.query<{ id: number; title: string; last: string | null; alerted: string | null }>(
    `SELECT s.id, s.title, max(c.uploaded_at)::text AS last, s.stall_alerted_at::text AS alerted
       FROM series s LEFT JOIN chapter c ON c.series_id = s.id
      WHERE NOT s.muted AND s.status <> 'COMPLETED'
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
    if ((upd.rowCount ?? 0) > 0 && !r.alerted) {
      await notify("Kupoyomi: series went quiet",
        `${r.title} has had no new chapter in ${Math.round(quiet)} days. Its source may have stopped carrying it.`);
      await p.query("UPDATE series SET stall_alerted_at = now() WHERE id = $1", [r.id]);
      flagged++;
    }
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
        if (!busy) {
          busy = true;
          await scanWanted();
          state.lastScan = { at: new Date().toISOString() };
        }
      } catch (err) {
        state.lastScan = { at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
      } finally { busy = false; }
      await sleep(scanEvery);
    }
  })();

  void (async () => {
    await sleep(60_000);                 // let the extension bootstrap settle first
    for (;;) {
      try {
        if (!busy) {
          busy = true;
          const before = state.lastFetch?.downloaded ?? 0;
          await fetchWanted({ limit: batch, concurrency });
          const out = (await db().query<{ n: string }>(
            "SELECT count(*) n FROM wanted WHERE state <> 'done'")).rows[0];
          state.outstanding = Number(out?.n ?? 0);
          state.lastFetch = { at: new Date().toISOString(), downloaded: before, failed: 0 };
        }
      } catch (err) {
        state.lastFetch = { at: new Date().toISOString(), downloaded: 0, failed: 0, error: err instanceof Error ? err.message : String(err) };
      } finally { busy = false; }
      await sleep(fetchEvery);
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
    `stall check every ${num("STALL_INTERVAL_HOURS", 24)}h`);
}
