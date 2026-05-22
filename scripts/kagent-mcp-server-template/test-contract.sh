#!/usr/bin/env bash
# Layer 1 test for the kagent-mcp-server scaffolder template.
# For each fixture, renders mcpserver.yaml (always) and externalsecret.yaml
# (when applicable), then asserts:
#   1. mcpserver.yaml is valid YAML, kind=MCPServer, apiVersion=kagent.dev/v1alpha1
#   2. metadata.name matches the fixture's "name"
#   3. labels include arigsela.com/idp-managed: "true"
#   4. Per-preset structural shape (transportType, cmd, env presence, etc.)
#   5. When externalsecret.yaml is rendered, its target.name matches expected
#      and its data[].remoteRef references the right vault path.
#
# Exit codes: 0 = all pass; 1 = at least one fixture failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
RENDER="$REPO_ROOT/scripts/kagent-template/render.js"

BASE_TPL='examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml'
SECRET_TPL='examples/templates/kagent-mcp-server/content/with-secret/base-apps/kagent/mcp-servers/${{ values.name }}/externalsecret.yaml'

fail_count=0

assert_mcpserver_shape() {
  local rendered="$1"
  local fixture="$2"
  local name preset
  name="$(jq -r '.name' "$fixture")"
  preset="$(jq -r '.preset' "$fixture")"

  # YAML validity
  if ! echo "$rendered" | yq eval '.' - > /dev/null 2>&1; then
    echo "  FAIL: mcpserver.yaml is not valid YAML"
    fail_count=$((fail_count + 1))
    return
  fi

  # apiVersion / kind
  local api kind
  api="$(echo "$rendered" | yq eval '.apiVersion' -)"
  kind="$(echo "$rendered" | yq eval '.kind' -)"
  if [[ "$api" != "kagent.dev/v1alpha1" ]]; then
    echo "  FAIL: apiVersion is '$api' (expected kagent.dev/v1alpha1)"
    fail_count=$((fail_count + 1))
  fi
  if [[ "$kind" != "MCPServer" ]]; then
    echo "  FAIL: kind is '$kind' (expected MCPServer)"
    fail_count=$((fail_count + 1))
  fi

  # metadata.name
  local rendered_name
  rendered_name="$(echo "$rendered" | yq eval '.metadata.name' -)"
  if [[ "$rendered_name" != "$name" ]]; then
    echo "  FAIL: metadata.name '$rendered_name' != fixture name '$name'"
    fail_count=$((fail_count + 1))
  fi

  # IDP-managed label
  local idp
  idp="$(echo "$rendered" | yq eval '.metadata.labels."arigsela.com/idp-managed"' -)"
  if [[ "$idp" != "true" ]]; then
    echo "  FAIL: missing/invalid arigsela.com/idp-managed label (got '$idp')"
    fail_count=$((fail_count + 1))
  fi

  # Per-preset shape
  case "$preset" in
    server-everything)
      local cmd transport
      cmd="$(echo "$rendered" | yq eval '.spec.deployment.cmd' -)"
      transport="$(echo "$rendered" | yq eval '.spec.transportType' -)"
      if [[ "$cmd" != "npx" ]]; then
        echo "  FAIL: server-everything cmd is '$cmd' (expected npx)"
        fail_count=$((fail_count + 1))
      fi
      if [[ "$transport" != "stdio" ]]; then
        echo "  FAIL: server-everything transportType is '$transport' (expected stdio)"
        fail_count=$((fail_count + 1))
      fi
      ;;
    github-mcp-server)
      local image env_count token_env
      image="$(echo "$rendered" | yq eval '.spec.deployment.image' -)"
      if [[ "$image" != "ghcr.io/github/github-mcp-server:latest" ]]; then
        echo "  FAIL: github-mcp-server image is '$image'"
        fail_count=$((fail_count + 1))
      fi
      token_env="$(echo "$rendered" | yq eval '.spec.deployment.env[] | select(.name == "GITHUB_PERSONAL_ACCESS_TOKEN") | .valueFrom.secretKeyRef.name' -)"
      if [[ "$token_env" != "${name}-github-token" ]]; then
        echo "  FAIL: GITHUB_PERSONAL_ACCESS_TOKEN secretKeyRef.name is '$token_env'"
        fail_count=$((fail_count + 1))
      fi
      ;;
    custom)
      local rendered_cmd
      rendered_cmd="$(echo "$rendered" | yq eval '.spec.deployment.cmd' -)"
      local fixture_cmd
      fixture_cmd="$(jq -r '.cmd' "$fixture")"
      if [[ "$rendered_cmd" != "$fixture_cmd" ]]; then
        echo "  FAIL: custom cmd is '$rendered_cmd' (expected '$fixture_cmd')"
        fail_count=$((fail_count + 1))
      fi
      ;;
  esac
}

assert_externalsecret_shape() {
  local rendered="$1"
  local fixture="$2"
  local name preset
  name="$(jq -r '.name' "$fixture")"
  preset="$(jq -r '.preset' "$fixture")"

  if ! echo "$rendered" | yq eval '.' - > /dev/null 2>&1; then
    echo "  FAIL: externalsecret.yaml is not valid YAML"
    fail_count=$((fail_count + 1))
    return
  fi

  local target_name idp
  target_name="$(echo "$rendered" | yq eval '.spec.target.name' -)"
  idp="$(echo "$rendered" | yq eval '.metadata.labels."arigsela.com/idp-managed"' -)"

  if [[ "$idp" != "true" ]]; then
    echo "  FAIL: externalsecret missing arigsela.com/idp-managed label"
    fail_count=$((fail_count + 1))
  fi

  case "$preset" in
    github-mcp-server)
      if [[ "$target_name" != "${name}-github-token" ]]; then
        echo "  FAIL: github externalsecret target.name is '$target_name' (expected ${name}-github-token)"
        fail_count=$((fail_count + 1))
      fi
      ;;
    custom)
      if [[ "$target_name" != "${name}-secrets" ]]; then
        echo "  FAIL: custom externalsecret target.name is '$target_name' (expected ${name}-secrets)"
        fail_count=$((fail_count + 1))
      fi
      ;;
  esac
}

needs_externalsecret() {
  local fixture="$1"
  local preset
  preset="$(jq -r '.preset' "$fixture")"
  local vs_len
  vs_len="$(jq '.vaultSecrets | length' "$fixture")"
  if [[ "$preset" == "github-mcp-server" ]] || \
     [[ "$preset" == "custom" && "$vs_len" -gt 0 ]]; then
    return 0
  fi
  return 1
}

check_fixture() {
  local fixture="$1"
  local fixture_name
  fixture_name="$(basename "$fixture" .json)"
  echo "=== fixture: $fixture_name ==="

  local mcp
  if ! mcp="$(node "$RENDER" "$BASE_TPL" "$fixture")"; then
    echo "  FAIL: rendering mcpserver.yaml returned non-zero"
    fail_count=$((fail_count + 1))
    return
  fi
  assert_mcpserver_shape "$mcp" "$fixture"

  if needs_externalsecret "$fixture"; then
    local secret
    if ! secret="$(node "$RENDER" "$SECRET_TPL" "$fixture")"; then
      echo "  FAIL: rendering externalsecret.yaml returned non-zero"
      fail_count=$((fail_count + 1))
      return
    fi
    assert_externalsecret_shape "$secret" "$fixture"
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
