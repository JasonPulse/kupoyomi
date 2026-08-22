# Downloads and the scheduler

The library keeps itself current: it scans for new chapters, fetches them at a deliberate
pace, and flags series whose source has gone quiet.

## Sub-features

- `/downloads`: what is fetching now with a per-chapter page bar, what just finished,
  throughput for the hour and day, and anything that gave up. Polls `/api/live`.
- `/queue`: the whole backlog with per-row state and the last error.
- Scheduler inside `serve`: scan every 6h, fetch 10 chapters every 15m across 2 sources,
  stall check daily. Independent locks, so a slow scan cannot starve fetching.
- Chapters are written to `.part` then renamed, so a mid-chapter failure cannot leave a
  truncated archive that looks complete.

## How to get to it (user POV)

`/downloads` for the live view, `/queue` for the backlog.

## Driving it with drive.sh

```bash
$D get /api/live
$D get /downloads
$D get /queue
$D get /api/stats     # scheduler keys show which jobs have run or are in flight
```

Proof that downloading actually works, without triggering anything:

```bash
$D sql "SELECT date_trunc('hour',finished_at) hr, count(*) n FROM wanted
        WHERE state='done' AND finished_at > now() - interval '6 hours' GROUP BY 1 ORDER BY 1 DESC"
$D sql "SELECT state, count(*), max(attempts) FROM wanted GROUP BY state"
```

A healthy instance shows ~40 completions an hour while the backlog lasts, `max(attempts)`
of 1, and no rows with `attempts >= 4`.

Then prove a downloaded file is real, end to end through the reader path:

```bash
$D get /api/pb/series/87/chapters
$D get /api/pb/chapter/87/196.0000        # page list read out of the CBZ
$D get /api/pb/page/87/196.0000/0         # must be image/*, non-trivial size
```

## Gotchas

- `scanStartedAt` or `fetchStartedAt` present with no matching `last*` means a job is in
  flight — or wedged. A missing `lastFetch` once meant downloads had silently stopped for
  hours because an untimed request hung the scan and a shared lock blocked the fetcher.
- Do not run `fetch` or `scan` by hand to "test" it. The scheduler owns the pace, and
  hammering a source is how this setup would finally get IP-banned.
- Page counts are written back when a chapter is first opened, so an adopted chapter can
  report `pages: null` until something reads it. That is not a fault.
