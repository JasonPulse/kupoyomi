# Library browsing

The landing page. Every series with its cover, how much is held, what is queued, which
source it is bound to, and how long since its last chapter.

## Sub-features

- Cover grid (default) and a list view behind `?view=list`.
- Title filter via `?q=`.
- Per-tile badges: `+N` when chapters are queued, `quiet` when the source has gone silent.
- Stat tiles: series, chapters held, queued, gone quiet.
- Series detail at `/series/<id>`: cover, synopsis, bindings with live per-source
  availability, the queue with its errors, gaps, and the chapter list.

## How to get to it (user POV)

Open `https://kupoyomi.network-gnomes.com/`. Click a cover to reach its series page.

## Driving it with drive.sh

```bash
export VERIFY_OUT=.verify/$(date +%Y%m%d-%H%M%S)
D=.claude/skills/verify-kupoyomi/scripts/drive.sh

$D get /
f="$VERIFY_OUT"/get__.txt
grep -c 'class="lc"' "$f"                              # one per series
grep -oE 'src="/series/[0-9]+/cover"' "$f" | wc -l     # how many have art
grep -c 'no cover' "$f"                                # and how many do not
grep -c 'repeat(4,1fr)' "$f"                           # stat row is four columns

$D get "/?view=list"
$D get "/?q=villain"

$D get /series/79                                       # a series with many chapters
$D get /series/79/cover                                 # must be image/jpeg, not 404
```

Proof of a working page: tile count equals the series count from `/api/stats`, and covers
resolve as JPEG rather than 404.

## Read state

Set from the series page, not from Paperback. A "read up to chapter" box marks that chapter
and everything below it, `mark all read` does the whole series, and each chapter row has a
read/unread toggle. Unread posts to `/api/pb/progress/clear` rather than writing a lower
value, because progress ratchets forward and cannot be lowered.

## Stopping updates

The Updates section on a series page. Stopping (the `muted` flag) means: no scan for new
chapters, its outstanding queue entries are deleted, no migration candidates offered, never
flagged as gone quiet. No file is deleted and it stays readable.

**The invariant is that a stopped series contributes nothing to the queue.** Not a paused
bucket, not a filtered view, no rows. Parking them was tried and rejected: 56 entries
nothing would ever act on made the queue unreadable. Nothing is lost, because entries are
derived from what the source carries.

```bash
$D sql "SELECT count(*) FROM wanted w JOIN series s ON s.id=w.series_id
        WHERE s.muted AND w.state <> 'done'"     # must be 0
```

Driving it writes to the owner's library, so stop and start in the same breath, and finish
with a scan so the backlog comes back:

```bash
curl -s -X POST .../series/68/mute    # stops it and drops its entries
curl -s -X POST .../series/68/mute    # starts it again
curl -s -X POST .../series/68/scan    # rebuilds what is still missing
```

## Gotchas

- Availability per binding on the series page is fetched **client-side** from
  `/api/binding/<id>`. The served HTML shows `checking`; drive that endpoint directly to
  prove the numbers.
- The stat tile row is a fixed four columns. Five tiles wrap and leave a hole — that was a
  real regression, so count the tiles.
- Every series should have cover art, including archived ones. Those have no source
  binding by design, so the cover comes from the best-shaped of the first eight pages of
  their earliest chapter. A `no cover` tile means the metadata pass has not reached it yet,
  or the archive is unreadable.
- On a pure webtoon every page is one long strip, so the fallback cover is a strip. That is
  the honest best answer without an image decoder; a proper cover needs the source
  thumbnail, and a source that no longer resolves the series cannot give one.
- Every POST route shares one `readBody` call at the top of the handler. Calling it again
  inside a route waits on an `end` event that has already fired, so the request hangs with
  nothing logged and nothing written. Use the `form` in scope.
- Panels are the parchment frame with the caps as pseudo-elements. A panel with padding
  smaller than the 27px cap hides its own contents; the library filter form vanished
  entirely that way. If a panel looks empty, check its padding before anything else.
