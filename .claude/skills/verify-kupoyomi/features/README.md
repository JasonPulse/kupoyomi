# Kupoyomi feature map

What a user actually touches, and how to prove each part works. Keep this honest as the
app changes — a proof that drives one endpoint is incomplete when this index lists others.

Read-only against the deployed instance unless a file says otherwise. Anything that writes
belongs in `npm test`, not here.

| Feature | Surface | File |
| --- | --- | --- |
| Library browsing | web, `/` | [library.md](library.md) |
| Global search and adding | web, `/search` + SSE | [search.md](search.md) |
| Per-source browse with filters | web, `/browse` + SSE | [browse.md](browse.md) |
| Migration review | web, `/review` | [migrations.md](migrations.md) |
| Downloads and the scheduler | web, `/downloads` + CLI | [downloads.md](downloads.md) |
| Reader API and extension repo | HTTP, `/api/pb/*`, `/paperback/` | [reader.md](reader.md) |

Not covered here, deliberately: `probe`, `confirm`, `remove`, `tidy`, `prune-candidates`
and `add`. They mutate the owner's library or uninstall their sources. Prove those with a
test against a throwaway database, following `test/removal.test.ts`.
