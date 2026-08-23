# Global search and adding

Searches every installed English source at once and streams results as each answers.

## Sub-features

- SSE stream at `/api/search?q=`, one `hit` per result, `progress` per source finishing.
- Results grouped by work, not by release: bracketed tags and anything after a pipe are
  stripped, so four language variants of one doujin collapse into one card with a `release`
  column.
- Typo tolerance: keys within two edits of an existing key fold in (14+ chars only).
- Per-source chapter counts, filled in afterwards from `/api/detail?mangaId=`.
- A `details` button to `/preview?source=&url=&title=`, which shows the source's whole
  chapter list without adding anything.
- Chapter counts are DISTINCT chapter numbers, not upload rows, with the highest chapter
  under them. ComicK reports 319 uploads of 129 numbers for a run that ends at 102, and a
  raw count made the worst entry look like the fullest.
- When the work is already in the library, three more columns appear, measured against
  what is held: chapters past your highest, holes it fills, and chapters you hold that it
  does not carry. This is what `/review` used to do and the reason it existed. Driven by
  passing `seriesId` to `/api/detail`.
- Adding posts in the background and does not navigate, so several results can be added.

## How to get to it (user POV)

`/search`, type a title, results appear as sources answer.

## Driving it with drive.sh

```bash
$D sse "/api/search?q=solo%20leveling" 25
# expect: start, then hit events within ~0.5s, progress counting to the source total, done

$D get "/api/detail?mangaId=1000"     # chapters, description, status, genres, lastUpload
$D get "/preview?source=2499283573021220255&url=%2Fmanga%2F32d76d19-8a05-4db0-9fc2-e0b0648fe9d0&title=Solo%20Leveling"
node scripts/check-client-js.mjs      # the page is inert if this fails
```

Proof: first `hit` inside a second or two, and `/preview` renders a chapter table or says
plainly that the source lists none.

## Migrating a series

Reached from a series page as "migrate to another source", or "choose a source" when
nothing is bound. It is this same page: the comparison columns only render once the group
matches a series you hold, which is what makes it a migration rather than an add.

```bash
$D get "/api/detail?mangaId=11514&seriesId=101"   # unique, total, highest, newBeyond, fillsGaps, notCarried
$D get "/api/detail?mangaId=11514"                # without seriesId, no comparison
```

Series 101, Kill the Villainess, is deliberately left with no source as a fixture for this
path. Do not bind it.

## Gotchas

- **The page's HTML contains no results.** Grouping and rendering happen in the browser.
  Asserting on `/search?q=x` markup proves only that the shell shipped.
- A source can match the title and carry **zero** chapters — that is what a DMCA'd entry
  looks like. Those render as `empty` with no add button. One chapter is legitimate and
  must stay addable.
- Do **not** POST `/add` here. That writes to the owner's library.
- `/preview` primes the manga on the source, which is a real request to a real site. It is
  read-only for us but not free for them; do not loop it.
