#!/usr/bin/env bash
# Read-only. Answers "is this instance worth driving?" and nothing else.
set -uo pipefail
CTX="${KUBE_CONTEXT:-pulse-clift}"
NS="${KUBE_NAMESPACE:-homelab}"
BASE="${KUPOYOMI_URL:-https://kupoyomi.network-gnomes.com}"
fail=0
say() { printf '%-34s %s\n' "$1" "$2"; }

pods=$(kubectl --context "$CTX" -n "$NS" get pods -l app=kupoyomi \
  -o 'custom-columns=R:.status.containerStatuses[0].ready,X:.status.containerStatuses[0].restartCount' \
  --no-headers 2>/dev/null)
[ -n "$pods" ] || { say "kupoyomi pod" "NOT FOUND"; fail=1; }
[ -n "$pods" ] && say "kupoyomi pod ready/restarts" "$pods"

sw=$(kubectl --context "$CTX" -n "$NS" get pods -l app=suwayomi \
  -o 'custom-columns=R:.status.containerStatuses[0].ready' --no-headers 2>/dev/null)
say "suwayomi pod ready" "${sw:-NOT FOUND}"
[ "${sw// /}" = "true" ] || fail=1

code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$BASE/healthz")
say "GET /healthz" "$code"
[ "$code" = "200" ] || fail=1

# The three dependencies the app cannot work without: its database, Suwayomi, and the
# share. /api/stats only answers if the database does.
stats=$(curl -s -m 25 "$BASE/api/stats")
if printf '%s' "$stats" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "series" in d' 2>/dev/null; then
  printf '%s' "$stats" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("%-34s %s" % ("database (via /api/stats)", "ok: %d series, %d chapters" % (d["series"], d["chapters"])))
print("%-34s %s" % ("queue outstanding/failed", "%d / %d" % (d["wanted_outstanding"], d["wanted_failed"])))
r = d.get("last_reconcile") or {}
# "installed" is how many were MISSING and got installed at boot, so 0 is the healthy
# steady state, not a failure. "unavailable" is the number that could not be installed.
bad = r.get("unavailable") or []
print("%-34s %s" % ("extensions declared/unavailable", "%s / %s%s" % (
    r.get("desired","?"), len(bad), (" " + ",".join(bad[:3])) if bad else "")))
print("%-34s %s" % ("extensions installed at boot", "%s" % r.get("installed","?")))
if r.get("error"): print("%-34s %s" % ("extension reconcile ERROR", r["error"]))
s = d.get("scheduler") or {}
print("%-34s %s" % ("scheduler jobs seen", ",".join(sorted(s.keys())) or "none yet"))'
else
  say "database (via /api/stats)" "UNREACHABLE"; fail=1
fi

sources=$(kubectl --context "$CTX" -n "$NS" exec deploy/kupoyomi -- node -e '
fetch(process.env.SUWAYOMI_URL,{method:"POST",headers:{"content-type":"application/json"},
 body:JSON.stringify({query:"{ sources{totalCount} extensions(condition:{isInstalled:true}){totalCount} }"})})
 .then(r=>r.json()).then(d=>console.log(d.data.extensions.totalCount+" extensions, "+d.data.sources.totalCount+" sources"))
 .catch(e=>{console.log("UNREACHABLE: "+e.message);process.exit(1)})' 2>/dev/null)
say "suwayomi api" "${sources:-UNREACHABLE}"
case "$sources" in *UNREACHABLE*|"") fail=1;; esac

share=$(kubectl --context "$CTX" -n "$NS" exec deploy/kupoyomi -- sh -c \
  'test -d /data/Library && test -d /data/Manga && df -h /data | tail -1' 2>/dev/null)
say "share mounted (/data)" "${share:-NOT MOUNTED}"
[ -n "$share" ] || fail=1

# The running image is :latest, so a green CI does not mean the pod has that build.
running=$(kubectl --context "$CTX" -n "$NS" get pods -l app=kupoyomi \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' 2>/dev/null | sed 's/.*@//')
say "running image digest" "${running:-unknown}"

[ "$fail" = 0 ] && echo "DOCTOR: ok, worth driving" || echo "DOCTOR: FAILED, do not trust a proof from this instance"
exit "$fail"
