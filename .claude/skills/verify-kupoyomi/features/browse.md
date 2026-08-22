# Per-source browse with filters

Pick a source, browse Popular or Latest, filter by the source's own genres.

## Sub-features

- `/browse` lists installed English sources, weakest last, flagging any whose
  `supportsLatest` is false as `may not list anything`.
- `/browse/<sourceId>?type=POPULAR|LATEST` streams a cover grid from `/api/browse`.
- Genre, status and demographic chips come from the source's real filter set and submit as
  structured `FilterChangeInput` values, not as search text.
- Filter state lives in the URL, so a filtered browse is bookmarkable.
- Up to three pages are fetched in sequence so results keep arriving.

## How to get to it (user POV)

`/browse`, click a source, click genre chips.

## Driving it with drive.sh

```bash
$D get /browse
grep -c 'may not list anything' "$VERIFY_OUT"/get_browse.txt   # weak sources flagged

MD=$($D sql "SELECT source_id FROM series_binding WHERE source_name='MangaDex (EN)' LIMIT 1" | grep -oE '[0-9]{6,}' | head -1)
$D sse "/api/browse?source=$MD&type=POPULAR" 30
# expect: start, hits, a page event per page with a running total, done

$D get "/browse/$MD?type=POPULAR"     # the shell; chips must render server-side
```

Proof: `page` events with an increasing total, and a `done` carrying that total. Genre
filtering is proven by adding `&f=<group>.<inner>.include` and seeing a different set.

## Gotchas

- A filtered listing is silently a `SEARCH` request, because `POPULAR` ignores filters.
  "Popular + Isekai" is therefore a filtered list, not a popularity ranking.
- Some sources return nothing for `POPULAR` at all (BaoBua does). The page must say so
  rather than spin; a silent `onerror` once left it on "loading" forever.
- Every terminal state must speak: `start`, `page`, `failed`, `done`. Silence is the bug.
