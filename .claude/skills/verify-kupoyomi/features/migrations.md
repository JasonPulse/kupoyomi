# Migration review

When a source dies, its chapters are stranded. This is where a new home is chosen — always
by a human, never automatically.

## Sub-features

- `/review` lists each stranded series with what you hold and what each candidate offers.
- Three separate numbers per candidate: **new releases** past your highest chapter,
  **fills gaps** inside your range, **not carried** (informational — you keep the files).
- A candidate carrying under half your run shows as `fragment`; one offering nothing newer
  shows as `nothing newer`. Neither is selectable.
- A dead source that has become installable again is marked `original source, back` and
  wins the recommendation, because its numbering matches by construction.
- Series the old library recorded as finished are split into their own list.
- Gap filling at `/series/<id>/gaps`: which sources carry the specific missing chapters.

## How to get to it (user POV)

`/review`, read the table, click `use this`. Or `/series/<id>` → `fill N gaps`.

## Driving it with drive.sh

```bash
$D get /review
f="$VERIFY_OUT"/get_review.txt
grep -c 'class="card"' "$f"
grep -c 'original source, back' "$f"
grep -c 'staying put is better' "$f"      # series where nothing beats what you hold

$D cli gaps 96                             # read-only: what is missing, who carries it
$D get /series/96/gaps
```

Proof: for a known series, the `new releases` figure equals `offered above your max`,
computed independently:

```bash
$D sql "SELECT max(chapter_number) FROM chapter WHERE series_id=96"
```

## Gotchas

- Never POST `/confirm` or `/archive` here. Both write to the library.
- `not carried` is **not** a loss. The ledger keeps every file; a remapped series can hold
  more than its source advertises.
- Comparison numbers are cached in `candidate_comparison` by the `candidates` command,
  which is a source-hitting write. Do not refresh it to "check" the page.
- Gap counts cover **whole** chapters only. A missing 12.2 is not treated as a hole, because
  one site's decimal split is not another's gap.
