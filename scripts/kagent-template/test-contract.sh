#!/usr/bin/env bash
# Layer 1 test for the kagent-agent v1 annotation contract.
# Renders each fixture via the offline Nunjucks renderer, then asserts:
#   1. Output is valid YAML
#   2. All 7 agents.platform.ai/* annotations are present
#   3. JSON-valued annotations parse and have the expected shapes
#   4. a2a-endpoint follows the convention http://<name>.kagent.svc.cluster.local:8080
#
# Exit codes: 0 = all pass; 1 = at least one fixture failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

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

fail_count=0

check_fixture() {
  local fixture="$1"
  local fixture_name
  fixture_name="$(basename "$fixture" .json)"

  echo "=== fixture: $fixture_name ==="

  local rendered
  if ! rendered="$(node "$SCRIPT_DIR/render.js" "$fixture")"; then
    echo "  FAIL: render returned non-zero"
    fail_count=$((fail_count + 1))
    return
  fi

  if ! echo "$rendered" | yq eval '.' - > /dev/null 2>&1; then
    echo "  FAIL: rendered output is not valid YAML"
    fail_count=$((fail_count + 1))
    return
  fi

  for ann in "${REQUIRED_ANNOTATIONS[@]}"; do
    local val
    val="$(echo "$rendered" | yq eval ".metadata.annotations.\"$ann\"" -)"
    if [[ "$val" == "null" || -z "$val" ]]; then
      echo "  FAIL: missing annotation: $ann"
      fail_count=$((fail_count + 1))
    fi
  done

  for ann in "${JSON_ANNOTATIONS[@]}"; do
    local val
    val="$(echo "$rendered" | yq eval ".metadata.annotations.\"$ann\"" -)"
    if ! echo "$val" | jq empty 2>/dev/null; then
      echo "  FAIL: $ann is not valid JSON: $val"
      fail_count=$((fail_count + 1))
    fi
  done

  local name
  name="$(jq -r '.name' "$fixture")"
  local expected_endpoint="http://${name}.kagent.svc.cluster.local:8080"
  local actual_endpoint
  actual_endpoint="$(echo "$rendered" | yq eval '.metadata.annotations."agents.platform.ai/a2a-endpoint"' -)"
  if [[ "$actual_endpoint" != "$expected_endpoint" ]]; then
    echo "  FAIL: a2a-endpoint mismatch"
    echo "    expected: $expected_endpoint"
    echo "    actual:   $actual_endpoint"
    fail_count=$((fail_count + 1))
  fi

  local version
  version="$(echo "$rendered" | yq eval '.metadata.annotations."agents.platform.ai/version"' -)"
  if [[ "$version" != "v1" ]]; then
    echo "  FAIL: version is not 'v1' (got '$version')"
    fail_count=$((fail_count + 1))
  fi

  local runtime
  runtime="$(echo "$rendered" | yq eval '.metadata.annotations."agents.platform.ai/runtime"' -)"
  if [[ "$runtime" != "kagent" ]]; then
    echo "  FAIL: runtime is not 'kagent' (got '$runtime')"
    fail_count=$((fail_count + 1))
  fi

  local description_in actual_description
  description_in="$(jq -r '.description' "$fixture" | sed 's/[[:space:]]*$//;s/^[[:space:]]*//')"
  actual_description="$(echo "$rendered" | yq eval '.metadata.annotations."agents.platform.ai/description"' -)"
  if [[ "$actual_description" != "$description_in" ]]; then
    echo "  FAIL: description round-trip mismatch (YAML-escaping bug?)"
    echo "    fixture input: $description_in"
    echo "    rendered:      $actual_description"
    fail_count=$((fail_count + 1))
  fi

  # spec.declarative.tools must always be a list (never null), or the kagent
  # CRD's OpenAPI validation rejects the resource at apply time.
  local tools_kind
  tools_kind="$(echo "$rendered" | yq eval '.spec.declarative.tools | tag' -)"
  if [[ "$tools_kind" != "!!seq" ]]; then
    echo "  FAIL: spec.declarative.tools must be a list (got tag '$tools_kind')"
    fail_count=$((fail_count + 1))
  fi

  echo "  done"
}

for fixture in "$FIXTURES_DIR"/*.json; do
  check_fixture "$fixture"
done

echo
if [[ $fail_count -eq 0 ]]; then
  echo "All fixtures passed."
  exit 0
else
  echo "$fail_count failure(s) across fixtures."
  exit 1
fi
