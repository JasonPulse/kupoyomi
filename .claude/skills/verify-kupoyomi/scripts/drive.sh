#!/usr/bin/env bash
# Drives the deployed instance and writes evidence. Read-only by default.
#   drive.sh get <path>              GET through the ingress, saved as evidence
#   drive.sh sse <path> <seconds>    consume a stream, timestamped per event
#   drive.sh cli <args...>           run the kupoyomi CLI in the pod
#   drive.sh sql <query>             read-only SELECT against its database
set -uo pipefail
CTX="${KUBE_CONTEXT:-pulse-clift}"
NS="${KUBE_NAMESPACE:-homelab}"
BASE="${KUPOYOMI_URL:-https://kupoyomi.network-gnomes.com}"
OUT="${VERIFY_OUT:?set VERIFY_OUT to the evidence directory}"
mkdir -p "$OUT"
cmd="${1:?get|sse|cli|sql}"; shift

slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-70; }

case "$cmd" in
  get)
    p="${1:?path}"; f="$OUT/get_$(slug "$p").txt"
    # --path-as-is so a traversal probe reaches the server as written instead of being
    # collapsed by curl, which would make the 404 prove nothing.
    curl -s -m 60 --path-as-is -D "$f.headers" -o "$f" \
      -w 'HTTP %{http_code} %{content_type} %{size_download}b in %{time_total}s\n' "$BASE$p" | tee "$f.meta"
    # Give binaries their real extension, so `file` and an image viewer both work on the
    # evidence. A JPEG saved as .txt reads like a failure when it is not.
    ct=$(sed -n 's/^HTTP [0-9]* \([^;/]*\/[^;[:space:]]*\).*/\1/p' "$f.meta")
    case "$ct" in
      image/jpeg) ext=jpg;; image/png) ext=png;; image/webp) ext=webp;;
      application/json) ext=json;; application/javascript|text/javascript) ext=js;;
      *) ext="";;
    esac
    if [ -n "$ext" ]; then
      mv "$f" "${f%.txt}.$ext"; mv "$f.headers" "${f%.txt}.$ext.headers"; mv "$f.meta" "${f%.txt}.$ext.meta"
      f="${f%.txt}.$ext"
    fi
    echo "evidence: $f"
    ;;
  sse)
    p="${1:?path}"; secs="${2:-20}"; f="$OUT/sse_$(slug "$p").log"
    python3 - "$BASE$p" "$secs" > "$f" <<'PY'
import sys, time, urllib.request
url, secs = sys.argv[1], float(sys.argv[2])
t0 = time.time(); ev = None
try:
    with urllib.request.urlopen(url, timeout=secs + 10) as r:
        for raw in r:
            if time.time() - t0 > secs: break
            line = raw.decode(errors="replace").rstrip()
            if line.startswith("event:"): ev = line[7:]
            elif line.startswith("data:"):
                print(f"+{time.time()-t0:6.2f}s {ev}: {line[6:][:160]}")
except Exception as e:
    print(f"+{time.time()-t0:6.2f}s CLIENT {type(e).__name__}: {e}")
PY
    tail -6 "$f"; echo "evidence: $f"
    ;;
  cli)
    f="$OUT/cli_$(slug "$*").log"
    kubectl --context "$CTX" -n "$NS" exec deploy/kupoyomi -- node dist/index.js "$@" 2>&1 | tee "$f"
    echo "evidence: $f"
    ;;
  sql)
    q="${1:?query}"
    case "$(printf '%s' "$q" | tr 'A-Z' 'a-z' | tr -d ' ')" in
      select*|with*) ;;
      *) echo "refusing: only SELECT/WITH are allowed here" >&2; exit 2;;
    esac
    f="$OUT/sql_$(date +%H%M%S).log"
    kubectl --context "$CTX" -n "$NS" exec deploy/kupoyomi -- node -e '
const pg=require("pg");(async()=>{const c=new pg.Client(process.env.DATABASE_URL);await c.connect();
const r=await c.query(process.argv[1]);console.table(r.rows.slice(0,40));await c.end();})()
 .catch(e=>{console.error(e.message);process.exit(1)})' "$q" 2>&1 | tee "$f"
    echo "evidence: $f"
    ;;
  *) echo "unknown: $cmd" >&2; exit 2;;
esac
