#!/usr/bin/env bash
# Layer 3 test: validates that the live kagent agents in the Backstage catalog
# were ingested from kagent 1.0 Agents (api.kagent.dev), which is what the
# kagent-shared resolver and the entity-page card rely on.
#
# The old agents.platform.ai/* annotation contract this script used to check
# was deleted from the Agent manifests on 2026-07-14.
#
# Usage:
#   BACKSTAGE_URL=http://localhost:7007 \
#   BACKSTAGE_TOKEN=<service-token-or-empty> \
#   EXPECTED_AGENTS=7 \
#   bash scripts/check-agent-contract.sh
#
# EXPECTED_AGENTS is optional; when set, fewer kagent-agent entities is a failure.
#
# Exit codes:
#   0 = all live agents conform
#   1 = at least one non-conforming agent, or fewer than EXPECTED_AGENTS
#   2 = infrastructure error (e.g. Backstage API unreachable or returned non-JSON)

set -euo pipefail

: "${BACKSTAGE_URL:?BACKSTAGE_URL is required (e.g. http://localhost:7007)}"
TOKEN="${BACKSTAGE_TOKEN:-}"
EXPECTED="${EXPECTED_AGENTS:-}"

AUTH_ARG=()
if [[ -n "$TOKEN" ]]; then
  AUTH_ARG=(-H "Authorization: Bearer $TOKEN")
fi

# Fetch all Component entities with spec.type == kagent-agent.
# Note: ${AUTH_ARG[@]+"${AUTH_ARG[@]}"} is the set -u-safe way to expand an
# array that may be empty (plain ${AUTH_ARG[@]} triggers "unbound variable").
entities="$(curl -fsS "${AUTH_ARG[@]+"${AUTH_ARG[@]}"}" \
  "$BACKSTAGE_URL/api/catalog/entities?filter=kind=Component,spec.type=kagent-agent")"

if ! count="$(echo "$entities" | jq 'length' 2>/dev/null)"; then
  echo "ERROR: Backstage API did not return valid JSON. Check BACKSTAGE_URL and BACKSTAGE_TOKEN." >&2
  echo "Response body (first 200 chars): ${entities:0:200}" >&2
  exit 2
fi
echo "Found $count kagent agent(s) in catalog"

fail_count=0
if [[ -n "$EXPECTED" && "$count" -lt "$EXPECTED" ]]; then
  echo "FAIL: expected at least $EXPECTED kagent agent(s)"
  fail_count=$((fail_count + 1))
fi

ann() { # ann <entity-name> <annotation>
  echo "$entities" | jq -r --arg n "$1" --arg a "$2" \
    '.[] | select(.metadata.name == $n) | .metadata.annotations[$a] // empty'
}

while IFS= read -r name; do
  echo "=== $name ==="
  kind="$(ann "$name" terasky.backstage.io/kubernetes-resource-kind)"
  api="$(ann "$name" terasky.backstage.io/kubernetes-resource-api-version)"
  res_name="$(ann "$name" terasky.backstage.io/kubernetes-resource-name)"
  res_ns="$(ann "$name" terasky.backstage.io/kubernetes-resource-namespace)"
  if [[ "$kind" != "Agent" ]]; then
    echo "  FAIL: ingested from kind '${kind:-?}', not Agent"
    fail_count=$((fail_count + 1))
  fi
  if [[ "$api" != api.kagent.dev/* ]]; then
    echo "  FAIL: api version '${api:-?}' is not api.kagent.dev/*"
    fail_count=$((fail_count + 1))
  fi
  if [[ -z "$res_name" || -z "$res_ns" ]]; then
    echo "  FAIL: missing kubernetes-resource-name/-namespace"
    fail_count=$((fail_count + 1))
  else
    echo "  A2A: /agents/$res_ns/$res_name"
  fi
done < <(echo "$entities" | jq -r '.[].metadata.name')

echo
if [[ $fail_count -eq 0 ]]; then
  echo "All $count agent(s) were ingested from kagent 1.0 Agents."
  exit 0
else
  echo "$fail_count failure(s) across $count agent(s)."
  exit 1
fi
