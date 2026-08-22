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
- Panels are the parchment frame with the caps as pseudo-elements. A panel with padding
  smaller than the 27px cap hides its own contents; the library filter form vanished
  entirely that way. If a panel looks empty, check its padding before anything else.
