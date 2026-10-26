#!/usr/bin/env bash
#
# Layer 3 contract validation for the RHDH Scorecard and the readiness MCP server.
#
# Asserts what the production readiness skill (arigsela/claude-agents,
# skills/readiness) and kagent rely on:
#   1. the scorecard backend is installed and registers the expected metrics;
#   2. the `readiness` MCP server lists exactly the scorecard + catalog read tools;
#   3. the existing `catalog` MCP server (kagent's backstage-catalog
#      RemoteMCPServer) still lists exactly its three tools;
#   4. with ENTITY_REF set, that entity has values for the GitHub and file-check
#      metrics. Dependabot metrics are printed, not asserted: they depend on the
#      repo's Dependabot alerts setting.
#
# Usage:
#   BACKSTAGE_URL=http://localhost:7007 bash scripts/check-scorecard-contract.sh
#   BACKSTAGE_URL=https://backstage.arigsela.com ENTITY_REF=component:hk-demo/hk-demo \
#     bash scripts/check-scorecard-contract.sh
#
# BACKSTAGE_TOKEN, when set, is sent as a bearer token (never printed).
#
# Exit codes (mirrors scripts/check-cve-contract.sh):
#   0 = contract holds
#   1 = contract violation: reachable, but a metric, tool list or value is wrong
#   2 = infrastructure error: backend unreachable, or the scorecard is not installed
set -euo pipefail

BACKSTAGE_URL="${BACKSTAGE_URL:-http://localhost:7007}"
ENTITY_REF="${ENTITY_REF:-}"

fail() {
  local msg="$1" code="${2:-1}"
  echo "FAIL: ${msg}" >&2
  exit "${code}"
}
pass() { echo "  ok: $*"; }
skip() { echo "  skip: $*"; }

AUTH=()
if [ -n "${BACKSTAGE_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${BACKSTAGE_TOKEN}")
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# get <path> <out-file> — prints the HTTP status; 000 when unreachable.
get() {
  curl -s -o "$2" -w '%{http_code}' --max-time 20 "${AUTH[@]+"${AUTH[@]}"}" "${BACKSTAGE_URL}$1" || echo 000
}

# mcp_tools <server> — prints the sorted tool names, one per line.
mcp_tools() {
  local out="${TMP}/mcp-$1.txt" code
  code=$(curl -s -o "${out}" -w '%{http_code}' --max-time 20 "${AUTH[@]+"${AUTH[@]}"}" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
    "${BACKSTAGE_URL}/api/mcp-actions/v1/$1" || echo 000)
  [ "${code}" = "000" ] && fail "MCP server $1 unreachable" 2
  [ "${code}" = "200" ] || fail "MCP server $1 answered HTTP ${code}"
  # Streamable HTTP answers with SSE: the JSON-RPC result is on the `data:` line.
  python3 -I -c '
import json, sys
text = open(sys.argv[1]).read()
line = next((l[5:].strip() for l in text.splitlines() if l.startswith("data:")), text)
for name in sorted(t["name"] for t in json.loads(line)["result"]["tools"]):
    print(name)
' "${out}"
}

echo "== 1. Scorecard backend registers the expected metrics =="
code=$(get /api/scorecard/metrics "${TMP}/metrics.json")
[ "${code}" = "000" ] && fail "${BACKSTAGE_URL} unreachable" 2
[ "${code}" = "404" ] && fail "scorecard not installed (GET /api/scorecard/metrics → 404)" 2
[ "${code}" = "200" ] || fail "GET /api/scorecard/metrics answered HTTP ${code}"
missing=$(python3 -I -c '
import json, sys
doc = json.load(open(sys.argv[1]))
items = doc.get("metrics", doc) if isinstance(doc, dict) else doc
ids = {m["id"] for m in items}
want = ["github.openPRs", "filecheck.runbook", "filecheck.docs"]
gaps = [w for w in want if w not in ids]
if not any(i.startswith("dependabot.") for i in ids):
    gaps.append("dependabot.*")
print(" ".join(gaps))
' "${TMP}/metrics.json")
[ -z "${missing}" ] || fail "metrics not registered: ${missing}"
pass "github.openPRs, filecheck.runbook, filecheck.docs and dependabot.* registered"

echo "== 2. readiness MCP server lists the scorecard and catalog read tools =="
want_readiness=$'get-catalog-entity\nget-entity-metrics\nlist-metrics\nquery-catalog-entities'
got=$(mcp_tools readiness)
[ "${got}" = "${want_readiness}" ] || fail "readiness tools: got [$(echo ${got})], want [$(echo ${want_readiness})]"
pass "readiness: $(echo ${got})"

echo "== 3. catalog MCP server is unchanged =="
want_catalog=$'get-catalog-entity\nget-catalog-model-description\nquery-catalog-entities'
got=$(mcp_tools catalog)
[ "${got}" = "${want_catalog}" ] || fail "catalog tools: got [$(echo ${got})], want [$(echo ${want_catalog})]"
pass "catalog: $(echo ${got})"

echo "== 4. Entity metrics have values =="
if [ -z "${ENTITY_REF}" ]; then
  skip "ENTITY_REF not set"
else
  path=$(python3 -I -c '
import sys
kind, rest = sys.argv[1].split(":", 1)
ns, name = rest.split("/", 1) if "/" in rest else ("default", rest)
print(f"/api/scorecard/metrics/catalog/{kind.lower()}/{ns}/{name}")
' "${ENTITY_REF}")
  code=$(get "${path}" "${TMP}/entity.json")
  [ "${code}" = "000" ] && fail "${BACKSTAGE_URL} unreachable" 2
  [ "${code}" = "200" ] || fail "GET ${path} answered HTTP ${code}"
  python3 -I -c '
import json, sys
results = {m["id"]: m for m in json.load(open(sys.argv[1]))}
bad = []
for want in ("github.openPRs", "filecheck.runbook", "filecheck.docs"):
    m = results.get(want) or {}
    result = m.get("result") or {}
    value = result.get("value")
    if m.get("status") != "success" or value is None:
        bad.append("%s: %s" % (want, m.get("error") or ("absent" if not m else "no value")))
    else:
        evaluation = (result.get("thresholdResult") or {}).get("evaluation")
        print("  ok: %s = %s (%s)" % (want, value, evaluation))
for mid, m in sorted(results.items()):
    if mid.startswith("dependabot."):
        value = (m.get("result") or {}).get("value")
        print("  info: %s status=%s value=%s" % (mid, m.get("status"), value))
if bad:
    print("FAIL: " + "; ".join(bad), file=sys.stderr)
    sys.exit(1)
' "${TMP}/entity.json"
fi

echo "contract holds"
