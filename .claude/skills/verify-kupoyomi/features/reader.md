# Reader API and extension repository

What Paperback talks to, and how the extension gets installed.

## Sub-features

- `/api/pb/series`, `/api/pb/series/<id>`, `/api/pb/series/<id>/chapters`.
- `/api/pb/chapter/<id>/<number>` returns page URLs read out of the CBZ itself.
- `/api/pb/page/<id>/<number>/<index>` returns the image, extracted from the archive.
- `/api/pb/cover/<id>` returns the stored cover.
- `POST /api/pb/progress` moves reading position forward only; `POST /api/pb/progress/clear`
  resets a chapter; `POST /api/pb/progress/upto` marks a chapter and everything below it
  read in one call.
- `GET /api/pb/series/<id>/progress` returns the highest chapter marked read.
- The extension declares `MANGA_TRACKING` and implements `MangaProgressProviding`, but
  **Paperback never calls any of it.** Its own log shows why: a source's read state is
  handled on the device by `ChapterProgressManager` with no request following, and the
  thing that does call out is a tracker, installed from a separate trackers repository
  (`paperback-ios.github.io/trackers-main`). A source cannot be a tracker by declaring an
  intent. Read state is set from the Kupoyomi web UI instead. The extension keeps the
  implementation because it costs nothing and works the day a source can be a tracker.
- `/paperback/` serves the built extension as a Paperback repository.

Chapters are addressed by **number**, never by a source's id, so a series that migrates
keeps its chapter ids and your place in it.

## How to get to it (user POV)

In Paperback, add `https://kupoyomi.network-gnomes.com/paperback/` as a source repository,
install Kupoyomi, then browse and read.

## Driving it with drive.sh

```bash
$D get /paperback/versioning.json      # must list the source with a version and intents
$D get /paperback/Kupoyomi/source.js   # application/javascript, tens of KB
$D get /paperback/Kupoyomi/includes/icon.png
$D get "/paperback/../src/server.ts"   # must be 404: traversal is refused

$D get /api/pb/series
$D get /api/pb/series/96/chapters
$D get /api/pb/chapter/96/72.0000
$D get /api/pb/page/96/72.0000/0       # image/*, and large enough to be a real page
$D get /api/pb/cover/96
$D get /api/pb/series/96/progress
```

Bulk marking writes to the owner's read state, so check what is there first, then undo it:

```bash
$D sql "SELECT count(*) FROM read_progress"
curl -s -X POST -H 'content-type: application/json' -d '{"seriesId":96,"chapter":"3.0000"}' \
  https://kupoyomi.network-gnomes.com/api/pb/progress/upto      # {"ok":true,"marked":3}
for c in 1.0000 2.0000 3.0000; do curl -s -X POST -H 'content-type: application/json' \
  -d "{\"seriesId\":96,\"chapter\":\"$c\"}" \
  https://kupoyomi.network-gnomes.com/api/pb/progress/clear; done
$D sql "SELECT count(*) FROM read_progress"                     # back to what it was
```

Proof the archive reader works: three independent readings of one chapter agree on its page
count. The API serves N page URLs, the ledger records N, and the archive holds N images.

```bash
$D sql "SELECT file_path, page_count FROM chapter WHERE series_id=96 AND chapter_number=72"

# pageEntries takes entries, not a path, and dist/ is ESM, so require() fails here
kubectl --context pulse-clift -n homelab exec deploy/kupoyomi -- node --input-type=module -e \
 'const m=await import("/app/dist/unzip.js");const e=m.pageEntries(await m.listEntries(process.env.P));console.log(e.length,e[0].name)'
```

Confirmed on 2026-08-22: 32 page URLs, `page_count` 32, 32 image entries starting at
`001.jpg`. Evidence in `.verify/20260822-120042/PROOF.md`.

## Gotchas

- Progress is a ratchet: a lower page never overwrites a higher one, and `completed` never
  clears. Verify with two POSTs in descending order, then read the chapter list back. Use
  `/api/pb/progress/clear` to undo a test write — and do undo it, it is the owner's data.
- The extension is pinned to `@paperback/types@0.8.0-alpha.47` for Paperback 0.8.11. The
  1.0.0-alpha line targets a newer app; upgrading silently breaks installation.
- Bump `version` in `Kupoyomi.ts` when the bundle changes, or the app has no reason to
  offer an update and the user keeps running the old source.
- Home sections must set `containsMoreItems: true`. That single flag is what makes the
  View More page reachable, and it is the only layout in Paperback that is a grid rather
  than one sideways-scrolling row.
- `getViewMoreItems` must return `metadata: undefined` on the last page. Handing back a
  page number past the end makes the app ask forever.
- Rebuilding the extension needs `cd paperback-ext && npx paperback bundle`, an explicit
  `rootDir`, and `@types/node@18`. Without the rootDir the bundler emits `sources: []`
  and says nothing.
- Nothing here proves Paperback *itself* installs the source. That needs the device.
- `/api/pb/series` lists fewer series than the library does, because archived and stranded
  series are excluded. 40 against 42 is correct, not a missing row.
- A chapter adopted from the old tree reports `pages: null` and no scanlator until it is
  first opened. The oldest chapters of a migrated series look empty for that reason.
