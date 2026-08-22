---
name: verify-kupoyomi
description: Drive the deployed Kupoyomi manga library (web UI, reader API, and CLI) and capture evidence that a change actually works. Use when asked to verify, prove, demo, or screenshot Kupoyomi behaviour, or after changing anything in src/ — because tsc passing and a 200 response both hide the bugs this app actually gets.
---

# Verifying Kupoyomi

Kupoyomi owns a manga library: series identity, a chapter ledger keyed on chapter number,
downloads from scraper sources via Suwayomi, and a reader API that Paperback consumes.

**Read this first: there is no local instance and there never will be.** The server needs
Postgres, a Suwayomi instance, and the CIFS media share mounted at `/data`. It runs in
Kubernetes, Argo owns the manifests, and the only instance holds ~4,200 real chapters and
41GB of the owner's library.

So verification splits in two, and mixing them up is how you damage real data:

| What you are proving | Where | How |
| --- | --- | --- |
| Read paths, rendering, API shape, current state | the deployed instance | `scripts/drive.sh` |
| Anything that writes rows or touches files | a throwaway Postgres + temp dirs | `npm test` |

**Never drive a mutating path against the deployed instance.** No adding series, no
`remove`, no `confirm`, no `prune-candidates`, no `tidy`, no `probe`. Those change the
owner's library or uninstall their sources. If a change touches that code, prove it with a
test like `test/removal.test.ts`, which builds a decoy folder in a temp dir and asserts the
real one is picked — that is the pattern to copy.

Two commands are safe to run against production because they only read: `report` and
`gaps`. Several others take `--dry-run` (`remove`, `prune-candidates`, `tidy`, `relayout`)
— **verify what a dry run actually skips before trusting it**, by checking the database and
the filesystem afterwards, not by trusting the flag's name.

## Launch

Nothing to launch. The instance is already running; your job is to confirm the running
build is the one you want to judge.

```bash
cd ~/Code/Node/Personal/Kupoyomi
git rev-parse --short HEAD                    # the build you think you are testing
```

The deployment runs `ghcr.io/jasonpulse/kupoyomi:latest` with `imagePullPolicy: Always`, so
CI going green does **not** mean the pod has that code. To make the pod match HEAD:

```bash
# wait for CI on your commit first, or you will deploy the previous build
gh_sha=$(git rev-parse --short HEAD)
curl -s "https://api.github.com/repos/JasonPulse/kupoyomi/actions/runs?per_page=5" |
  python3 -c 'import json,sys;[print(r["head_sha"][:7], r["status"], r["conclusion"]) for r in json.load(sys.stdin)["workflow_runs"]]'

kubectl --context pulse-clift -n homelab rollout restart deploy/kupoyomi
kubectl --context pulse-clift -n homelab rollout status deploy/kupoyomi --timeout=240s
```

`rollout status` returning does **not** mean the ingress has caught up. Poll for the thing
you expect before concluding anything:

```bash
for i in $(seq 1 30); do
  curl -s -m 15 -o /tmp/p.html https://kupoyomi.network-gnomes.com/ && grep -q 'class="lc"' /tmp/p.html && break
done
```

Skipping that poll has produced three separate false "I broke the page" conclusions in this
repo's history. The page was fine every time; the old pod was still serving.

## Doctor

Run this first, always. Read-only, exits non-zero when the instance is not worth driving.

```bash
.claude/skills/verify-kupoyomi/scripts/doctor.sh
```

It checks both pods, `/healthz`, the database (via `/api/stats`), the Suwayomi API and its
installed source count, that `/data` is mounted, and prints the running image digest. A
failure here means any proof you gather is worthless — fix the instance first.

## Drive

```bash
export VERIFY_OUT=.verify/$(date +%Y%m%d-%H%M%S)
D=.claude/skills/verify-kupoyomi/scripts/drive.sh

$D get /                              # a page, saved with status and timing
$D get /api/pb/series                 # reader API
$D sse "/api/search?q=solo%20leveling" 20   # a stream, timestamped per event
$D cli report                          # the CLI, inside the pod
$D sql "SELECT count(*) FROM chapter"  # read-only; anything but SELECT/WITH is refused
```

There is **no browser harness**. The MCP preview tool fails against this host, so a "screenshot"
is not available. Assert on served markup instead, which is what the pages are made of:

```bash
$D get /
grep -c 'class="lc"' "$VERIFY_OUT"/get__.txt          # cover tiles rendered
grep -oE 'src="/series/[0-9]+/cover"' "$VERIFY_OUT"/get__.txt | wc -l
```

For pages whose content is built client-side (`/search`, `/browse/<id>`), the HTML contains
only the shell — **the served markup will not contain the results**. Drive the underlying
SSE endpoint instead (`/api/search`, `/api/browse`), and separately confirm the page's
inline script parses, because a broken client script returns a perfectly good 200 with a
dead page:

```bash
node scripts/check-client-js.mjs        # parses every String.raw client block
```

## Evidence

Everything lands in `$VERIFY_OUT` (`.verify/<timestamp>/`, git-ignored). Each `get` writes
the body, its headers, and a `.meta` line with status, content type, size and timing. The
body gets the extension its content type implies, so `file` and an image viewer both work
on it, and a served page you can open in a browser is a `.txt`.

Write a `PROOF.md` next to the artifacts saying what was driven and which cross-check makes
it a proof rather than a pile of 200s. `.verify/20260822-120042/PROOF.md` is the worked
example: the reader API, proven by three independent readings agreeing on one page count.

Proof standards for this app:

- **Exercise the user's path.** `/api/pb/chapter/<id>/<n>` proves the reader works; reading
  a row out of the `chapter` table does not.
- **Capture the state, not just the last screen.** For a download, capture the queue before,
  the `ok` lines, and the queue after.
- **Verify the side effect too.** A chapter is only downloaded if the CBZ exists, is a valid
  archive, and has a ledger row. `unzip -t` the file, or read it through `/api/pb/page/...`.
- **Beware the hardlink.** Every adopted chapter has a second name pointing at the same
  inode. A file existing does not prove *this* series produced it — compare inodes (see
  `src/remove.ts` `planRemoval`).
- **No mocks.** The production boundary here is Suwayomi, and it is a real dependency of
  every meaningful path. If you find yourself wanting to mock it, you are proving logic, and
  logic belongs in `npm test`.

## Cleanup

Nothing persistent is started, so cleanup is small — but do it, and never with `pkill`:

```bash
# only if you opened a port-forward; kill the pid you created, not by name
[ -n "${PF_PID:-}" ] && kill "$PF_PID"
rm -f /tmp/p.html
docker rm -f kupo-itest 2>/dev/null   # only if you started a test database
```

Do **not** delete `.verify/`. The evidence outlives the run; that is the point of it.

If you ran a `--dry-run` command, confirm afterwards that it really changed nothing:

```bash
$D sql "SELECT count(*) FROM series"    # compare against the count from before
```

## Helpers

- `scripts/doctor.sh` — read-only health check, exits non-zero when the instance is unfit.
- `scripts/drive.sh` — `get` / `sse` / `cli` / `sql`, writing evidence to `$VERIFY_OUT`.
  `get` sends the path as written (`--path-as-is`), so a traversal probe is honest.
  `cli` runs `node dist/index.js` inside the pod; `dist/` is ESM, so `require()` fails in
  any one-off `node -e` you write against it. Use `node --input-type=module -e` and `await
  import(...)`.

## Feature map

`features/README.md` indexes the user-facing features and how to drive each one. A proof
that exercises one convenient endpoint is incomplete when the map lists others; check it
before claiming a feature works.
