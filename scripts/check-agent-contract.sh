#!/usr/bin/env bash
# Layer 3 test: validates that live kagent agents in the Backstage catalog
# carry the v1 agents.platform.ai/* annotation contract.
#
# Usage:
#   BACKSTAGE_URL=http://localhost:7007 \
#   BACKSTAGE_TOKEN=<service-token-or-empty> \
#   bash scripts/check-agent-contract.sh
#
# Exit codes:
#   0 = all live agents conform
#   1 = at least one non-conforming agent
#   2 = infrastructure error (e.g. Backstage API unreachable or returned non-JSON)

set -euo pipefail

: "${BACKSTAGE_URL:?BACKSTAGE_URL is required (e.g. http://localhost:7007)}"
TOKEN="${BACKSTAGE_TOKEN:-}"

AUTH_ARG=()
if [[ -n "$TOKEN" ]]; then
  AUTH_ARG=(-H "Authorization: Bearer $TOKEN")
fi

REQUIRED_ANNOTATIONS=(
  "agents.platform.ai/version"
  "agents.platform.ai/runtime"
  "agents.platform.ai/description"
  "agents.platform.ai/a2a-endpoint"
  "agents.platform.ai/skills"
  "agents.platform.ai/delegates"
  "agents.platform.ai/capabilities"
)

JSON_ANNOTATIONS=(
  "agents.platform.ai/skills"
  "agents.platform.ai/delegates"
  "agents.platform.ai/capabilities"
)

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
if [[ "$count" -eq 0 ]]; then
  echo "Note: no agents to validate. Either none are deployed yet or the ingestor hasn't run."
  exit 0
fi

fail_count=0

while IFS= read -r entity_name; do
  echo "=== $entity_name ==="

  for ann in "${REQUIRED_ANNOTATIONS[@]}"; do
    val="$(echo "$entities" | jq -r ".[] | select(.metadata.name == \"$entity_name\") | .metadata.annotations[\"$ann\"] // empty")"
    if [[ -z "$val" ]]; then
      echo "  FAIL: missing annotation: $ann"
      fail_count=$((fail_count + 1))
    fi
  done

  for ann in "${JSON_ANNOTATIONS[@]}"; do
    val="$(echo "$entities" | jq -r ".[] | select(.metadata.name == \"$entity_name\") | .metadata.annotations[\"$ann\"] // empty")"
    if [[ -n "$val" ]] && ! echo "$val" | jq empty 2>/dev/null; then
      echo "  FAIL: $ann is not valid JSON: $val"
      fail_count=$((fail_count + 1))
    fi
  done

  # Strict v1 check; update when v2 contract is ratified.
  # The presence-of-version check is covered by REQUIRED_ANNOTATIONS above, so
  # only flag value mismatch here when the annotation is actually present.
  version="$(echo "$entities" | jq -r ".[] | select(.metadata.name == \"$entity_name\") | .metadata.annotations[\"agents.platform.ai/version\"] // empty")"
  if [[ -n "$version" && "$version" != "v1" ]]; then
    echo "  FAIL: version is not 'v1' (got '$version')"
    fail_count=$((fail_count + 1))
  fi

  echo "  done"
done < <(echo "$entities" | jq -r '.[].metadata.name')

echo
if [[ $fail_count -eq 0 ]]; then
  echo "All $count agent(s) conform to v1 contract."
  exit 0
else
  echo "$fail_count failure(s) across $count agent(s)."
  exit 1
fi
