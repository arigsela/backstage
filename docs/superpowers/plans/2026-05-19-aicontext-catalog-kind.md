# AIContext Catalog Modeling for kagent Agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `kagent-agent` scaffolder template so every rendered Agent CRD carries a `agents.platform.ai/*` annotation contract that makes the agent queryable as a structured concept via the Backstage catalog API.

**Architecture:** Single-file change to the rendered CRD template, JSON-encoded annotations via Nunjucks `| dump`, no new wizard parameters, no upstream upgrades. Verification via an offline Nunjucks render harness (Layer 1) plus a catalog-API contract reader script (Layer 3). Layer 2 (live ingestion correctness) is operator-driven once the change is deployed.

**Tech Stack:** Backstage v1.48.0 scaffolder templates (Nunjucks), Node 25.x (already installed for Backstage), `yq` + `jq` (already installed on dev box) for shell assertions, Jest 30 (already a dev dep, used for the offline render test).

**Reference spec:** `docs/superpowers/specs/2026-05-19-aicontext-catalog-kind-design.md`

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml` | Modify | Add 7 `agents.platform.ai/*` annotations to `metadata.annotations` |
| `scripts/kagent-template/render.js` | Create | Standalone Node renderer for the kagent CRD Nunjucks template (used by Layer 1 tests) |
| `scripts/kagent-template/fixtures/minimal.json` | Create | Fixture: minimum-valid wizard inputs (empty skills, empty delegates) |
| `scripts/kagent-template/fixtures/full.json` | Create | Fixture: one skill with examples+tags, two delegates |
| `scripts/kagent-template/test-contract.sh` | Create | Layer 1 test: renders each fixture, asserts 7 annotations + JSON shapes |
| `scripts/check-agent-contract.sh` | Create | Layer 3 test: queries Backstage catalog API, validates annotations on live agents |
| `docs/guides/agent-annotation-contract-v1.md` | Create | Public-facing contract docs for future MCP authors and scorecard authors |
| `docs/plans/auto-discovery-contract-implementation-plan.md` | Modify | Add cross-reference to the new contract |

**Why these boundaries:**
- The renderer (`render.js`) and the fixture files are pure I/O — keeping them separate from the test logic lets us reuse the renderer in other contexts (e.g. a Jest test later, or a CI step).
- `test-contract.sh` is the orchestrator. It's a shell script (not Jest) because the assertions are mostly YAML/JSON structural checks that `yq`/`jq` express more naturally than Jest matchers.
- `check-agent-contract.sh` is the post-deploy mirror of the offline test, against the catalog API.
- Documentation lives under `docs/guides/` (matches existing pattern in the repo).

---

## Task 1: Layer 1 offline render harness — write the failing test

This task locks in the contract in machine-readable form **before** changing the template. The test will fail against today's template (no `agents.platform.ai/*` annotations); Task 2 makes it pass.

**Files:**
- Create: `scripts/kagent-template/render.js`
- Create: `scripts/kagent-template/fixtures/minimal.json`
- Create: `scripts/kagent-template/fixtures/full.json`
- Create: `scripts/kagent-template/test-contract.sh`

- [ ] **Step 1: Create the Nunjucks renderer**

Create `scripts/kagent-template/render.js`:

```javascript
#!/usr/bin/env node
// Offline renderer for the kagent-agent scaffolder template.
// Usage: node render.js <fixture.json> > rendered.yaml
//
// Mirrors Backstage scaffolder's Nunjucks setup:
//   - Custom variable tags: ${{ ... }} (not {{ ... }})
//   - Custom `dump` filter that JSON-stringifies
//   - Standard `trim`, `length`, `indent` filters from Nunjucks core

const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');

const REPO_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_PATH = path.join(
  REPO_ROOT,
  'examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml',
);

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error('Usage: node render.js <fixture.json>');
  process.exit(2);
}

const values = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const templateSource = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const env = new nunjucks.Environment(null, {
  autoescape: false,
  tags: { variableStart: '${{', variableEnd: '}}' },
});
env.addFilter('dump', v => JSON.stringify(v));

// The template references `values.X`, so wrap accordingly.
const rendered = env.renderString(templateSource, { values });
process.stdout.write(rendered);
```

- [ ] **Step 2: Create minimal fixture**

Create `scripts/kagent-template/fixtures/minimal.json`:

```json
{
  "name": "test-minimal",
  "description": "Smallest valid kagent agent for contract verification.",
  "owner": "group:platform-engineering",
  "systemMessage": "You are a test agent.",
  "includeBuiltinPrompts": false,
  "delegateAgents": [],
  "skills": [],
  "cpuRequest": "100m",
  "cpuLimit": "500m",
  "memoryRequest": "128Mi",
  "memoryLimit": "512Mi",
  "compactionInterval": 10,
  "overlapSize": 2
}
```

- [ ] **Step 3: Create full fixture**

Create `scripts/kagent-template/fixtures/full.json`:

```json
{
  "name": "test-full",
  "description": "Coordinates 'release' & deploy: orchestrates other agents.",
  "owner": "group:platform-engineering",
  "systemMessage": "You coordinate other agents.",
  "includeBuiltinPrompts": true,
  "delegateAgents": ["helm-agent", "git-agent"],
  "skills": [
    {
      "id": "coordinate-release",
      "name": "Coordinate release",
      "description": "Orchestrate a multi-step release.",
      "examples": ["Release version 1.2.3", "Cut a hotfix"],
      "tags": ["release", "coordination"]
    }
  ],
  "cpuRequest": "200m",
  "cpuLimit": "1000m",
  "memoryRequest": "256Mi",
  "memoryLimit": "1Gi",
  "compactionInterval": 20,
  "overlapSize": 4
}
```

- [ ] **Step 4: Create the Layer 1 test script**

Create `scripts/kagent-template/test-contract.sh`:

```bash
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
```

- [ ] **Step 5: Make the test script executable and run it (expect failures)**

```bash
chmod +x scripts/kagent-template/test-contract.sh scripts/kagent-template/render.js
bash scripts/kagent-template/test-contract.sh || true
```

Expected output: every fixture reports `FAIL: missing annotation: agents.platform.ai/version` (and 6 other missing annotations), exit code 1. This confirms the test catches the missing contract.

- [ ] **Step 6: Commit**

```bash
git add scripts/kagent-template/
git commit -m "test(kagent): add Layer 1 render-contract harness

Offline Nunjucks renderer + fixtures + bash assertions for the
v1 agent annotation contract. Currently fails against the template
(no agents.platform.ai/* annotations); will pass after the template
change in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add the v1 annotation contract to the kagent CRD template

Now make the failing tests pass by adding the 7 annotations to the rendered CRD.

**Files:**
- Modify: `examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml`

- [ ] **Step 1: Add the annotations**

Edit the file. The existing `metadata.annotations` block is at lines 12–16. Insert 7 new annotations after `backstage.io/owner`, **before** the `spec:` block at line 17:

Current state (lines 12–17):
```yaml
  annotations:
    terasky.backstage.io/add-to-catalog: "true"
    terasky.backstage.io/component-type: kagent-agent
    backstage.io/managed-by-location: url:https://github.com/arigsela/kubernetes/blob/main/base-apps/kagent/agents/${{ values.name }}.yaml
    backstage.io/owner: ${{ values.owner }}
spec:
```

New state:
```yaml
  annotations:
    terasky.backstage.io/add-to-catalog: "true"
    terasky.backstage.io/component-type: kagent-agent
    backstage.io/managed-by-location: url:https://github.com/arigsela/kubernetes/blob/main/base-apps/kagent/agents/${{ values.name }}.yaml
    backstage.io/owner: ${{ values.owner }}
    # === agents.platform.ai/* v1 contract ===
    # Structured metadata mirrored to the Backstage catalog by the TeraSky
    # kubernetes-ingestor. Consumed by future MCP-backed assistants to
    # enumerate and call this agent. Contract spec:
    # docs/superpowers/specs/2026-05-19-aicontext-catalog-kind-design.md
    agents.platform.ai/version: "v1"
    agents.platform.ai/runtime: kagent
    agents.platform.ai/description: |-
      ${{ values.description | trim }}
    agents.platform.ai/a2a-endpoint: http://${{ values.name }}.kagent.svc.cluster.local:8080
    agents.platform.ai/skills: |-
      ${{ values.skills | dump }}
    agents.platform.ai/delegates: |-
      ${{ values.delegateAgents | dump }}
    agents.platform.ai/capabilities: '{"streaming":true,"a2a":true}'
spec:
```

- [ ] **Step 2: Re-run the Layer 1 tests (expect pass)**

```bash
bash scripts/kagent-template/test-contract.sh
```

Expected output: `All fixtures passed.`, exit code 0.

- [ ] **Step 3: Inspect a rendered fixture by hand to confirm shape**

```bash
node scripts/kagent-template/render.js scripts/kagent-template/fixtures/full.json | yq eval '.metadata.annotations' -
```

Expected: all 7 `agents.platform.ai/*` keys present; `skills` value parses as the full fixture's skills array when fed to `jq`; `delegates` is `["helm-agent","git-agent"]`.

- [ ] **Step 4: Verify the existing example agents in `examples/entities.yaml` still load**

This is a regression smoke check. The change is additive, but confirm the YAML schema still parses:

```bash
yq eval '.' examples/templates/kagent-agent/content/base-apps/kagent/agents/'${{ values.name }}.yaml' > /dev/null
echo "exit: $?"
```

Expected: exit 0 (file parses as YAML even with the Nunjucks placeholders intact, because `yq` treats them as string content).

- [ ] **Step 5: Commit**

```bash
git add 'examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml'
git commit -m "feat(kagent): emit agents.platform.ai/* v1 contract

Adds 7 structured annotations to the rendered kagent Agent CRD so
MCP-backed assistants can enumerate and call agents via the
Backstage catalog API without a second K8s API hop.

Layer 1 contract test (scripts/kagent-template/test-contract.sh)
now passes. See docs/superpowers/specs/2026-05-19-aicontext-catalog-kind-design.md
for the contract definition and migration path to upstream AIContext.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Layer 3 contract reader (post-deployment validation)

Once the template change is merged, ArgoCD syncs, and TeraSky ingests, an operator runs this script to confirm the annotations made it through the K8s → ingestor → catalog round-trip on a real agent.

**Files:**
- Create: `scripts/check-agent-contract.sh`

- [ ] **Step 1: Create the catalog-query script**

Create `scripts/check-agent-contract.sh`:

```bash
#!/usr/bin/env bash
# Layer 3 test: validates that live kagent agents in the Backstage catalog
# carry the v1 agents.platform.ai/* annotation contract.
#
# Usage:
#   BACKSTAGE_URL=http://localhost:7007 \
#   BACKSTAGE_TOKEN=<service-token-or-empty> \
#   bash scripts/check-agent-contract.sh
#
# Exit codes: 0 = all live agents conform; 1 = at least one non-conforming.

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
entities="$(curl -fsS "${AUTH_ARG[@]}" \
  "$BACKSTAGE_URL/api/catalog/entities?filter=kind=Component,spec.type=kagent-agent")"

count="$(echo "$entities" | jq 'length')"
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
      echo "  FAIL: $ann is not valid JSON"
      fail_count=$((fail_count + 1))
    fi
  done

  version="$(echo "$entities" | jq -r ".[] | select(.metadata.name == \"$entity_name\") | .metadata.annotations[\"agents.platform.ai/version\"] // empty")"
  if [[ "$version" != "v1" ]]; then
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
```

- [ ] **Step 2: Make it executable and dry-run against an empty/unavailable catalog**

```bash
chmod +x scripts/check-agent-contract.sh
BACKSTAGE_URL=http://localhost:7007 bash scripts/check-agent-contract.sh || true
```

Expected: either (a) connection refused if dev server isn't running (acceptable — script is for operators with a live server), or (b) "Found 0 kagent agent(s) in catalog" followed by exit 0 if no agents are deployed yet, or (c) per-agent validation output. All three are acceptable outcomes — we're just confirming the script doesn't crash.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-agent-contract.sh
git commit -m "test(kagent): add Layer 3 catalog-API contract reader

Operator-run script that queries the Backstage catalog API for all
kagent-agent components and validates the v1 agents.platform.ai/*
contract end-to-end (after K8s -> TeraSky ingestor -> catalog).

Will be the canary for breakage on Backstage or TeraSky upgrades,
and the seed of the future MCP server's catalog reader.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Documentation

Public-facing contract docs so future MCP authors and scorecard authors can rely on this contract without re-deriving it from source.

**Files:**
- Create: `docs/guides/agent-annotation-contract-v1.md`
- Modify: `docs/plans/auto-discovery-contract-implementation-plan.md`

- [ ] **Step 1: Create the contract guide**

Create `docs/guides/agent-annotation-contract-v1.md`:

```markdown
# Agent Annotation Contract — v1

> Companion to the kagent-agent scaffolder template. Documents the
> `agents.platform.ai/*` annotations that every IDP-managed kagent
> Agent carries in both its K8s CRD and its Backstage catalog entity.
>
> Design spec: `docs/superpowers/specs/2026-05-19-aicontext-catalog-kind-design.md`

## Purpose

Make kagent agents queryable as a first-class, structured concept in
the Backstage catalog so that MCP-backed assistants and scorecard
checks can read them via the catalog API alone, without a second K8s
API hop.

## Where the contract lives

- **Source of truth:** `metadata.annotations` on the rendered
  `kagent.dev/v1alpha2` Agent CRD in `arigsela/kubernetes`.
- **Catalog mirror:** TeraSky's `kubernetes-ingestor` copies the
  annotations 1:1 onto the resulting `kind: Component, spec.type: kagent-agent`
  entity in the Backstage catalog.
- **Query:** `GET /api/catalog/entities?filter=kind=Component,spec.type=kagent-agent`

## Fields (v1)

| Annotation | Type | Required | Description |
| --- | --- | --- | --- |
| `agents.platform.ai/version` | string (`"v1"`) | yes | Contract version. Consumers must reject unknown versions. |
| `agents.platform.ai/runtime` | string (`kagent`) | yes | Runtime that hosts this agent. Discriminator for future multi-runtime support. |
| `agents.platform.ai/description` | string | yes | Human-readable one-liner, ≤200 chars. |
| `agents.platform.ai/a2a-endpoint` | URL | yes | Where to call this agent (A2A protocol). For kagent: `http://<name>.kagent.svc.cluster.local:8080`. |
| `agents.platform.ai/skills` | JSON array | yes (may be `[]`) | A2A skills: `[{id,name,description,examples?,tags?}, …]` |
| `agents.platform.ai/delegates` | JSON array of strings | yes (may be `[]`) | Peer agent names this agent is allowed to call. |
| `agents.platform.ai/capabilities` | JSON object | yes | Capability flags. For kagent v1: `{"streaming":true,"a2a":true}`. |

## Consumers (reader code)

The minimum reader code to enumerate agents from the catalog:

```bash
curl -s "$BACKSTAGE_URL/api/catalog/entities?filter=kind=Component,spec.type=kagent-agent" \
  | jq '.[] | {
      name: .metadata.name,
      desc: .metadata.annotations["agents.platform.ai/description"],
      endpoint: .metadata.annotations["agents.platform.ai/a2a-endpoint"],
      skills: (.metadata.annotations["agents.platform.ai/skills"] | fromjson),
      delegates: (.metadata.annotations["agents.platform.ai/delegates"] | fromjson)
    }'
```

## Validation tools

- **Offline (Layer 1):** `bash scripts/kagent-template/test-contract.sh`
- **Live catalog (Layer 3):** `BACKSTAGE_URL=… bash scripts/check-agent-contract.sh`

## Forward compatibility

The v1 namespace and shape were chosen to migrate cleanly to the
upstream `kind: AIContext` proposal (RFC #33575) when it ships. The
migration path and field mapping are documented in the design spec.

## Future versions

Anticipated v2 additions (not implemented):

- `agents.platform.ai/system-message-digest` — change detection
- `agents.platform.ai/disciplines` — when MCP routing needs discipline-aware selection
- `agents.platform.ai/categories` — when group-by-category becomes useful

Adding v2 fields will bump `agents.platform.ai/version` to `"v2"`. Consumers should default-reject unknown versions rather than ignoring fields they don't understand.
```

- [ ] **Step 2: Add cross-reference to the auto-discovery plan**

Open `docs/plans/auto-discovery-contract-implementation-plan.md`. After the "Overview" section heading and its body paragraph (around lines 1–10), add a short "Related work" block:

```markdown
## Related work

- **`agents.platform.ai/*` v1 contract** — kagent agents emit a structured annotation contract for MCP and scorecard consumers. See `docs/guides/agent-annotation-contract-v1.md` and the design spec at `docs/superpowers/specs/2026-05-19-aicontext-catalog-kind-design.md`. This and the auto-discovery contract are intentionally orthogonal: the auto-discovery contract describes how a frontend finds *running* orchestrators via K8s Service labels; the agent annotation contract describes how MCP enumerates *catalog-registered* agents.
```

(If the file already has a "Related work" section, append to it instead of creating a duplicate.)

- [ ] **Step 3: Commit**

```bash
git add docs/guides/agent-annotation-contract-v1.md docs/plans/auto-discovery-contract-implementation-plan.md
git commit -m "docs(kagent): document agents.platform.ai/* v1 contract

Public-facing guide for MCP authors and scorecard authors who want
to consume kagent agents from the Backstage catalog. Cross-references
the design spec and the auto-discovery contract plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Operator verification checklist (post-merge)

These steps are out of scope for the implementation tasks above —
they are run by an operator after the PR merges and ArgoCD syncs.
Listed here so they're not forgotten.

- [ ] Scaffold a new test agent via the Backstage wizard (with
      `dryRun: false`). Confirm the PR opens in `arigsela/kubernetes`
      with the new annotations on the Agent CRD.
- [ ] After merging the GitOps PR, wait ~30s for ArgoCD sync, then
      wait another ~30s for the TeraSky ingestor's next pass.
- [ ] Run `BACKSTAGE_URL=… bash scripts/check-agent-contract.sh` and
      confirm exit code 0.
- [ ] Optionally clean up the test agent via the
      `kagent-agent-decommission` template.

---

## Self-review notes

- All 7 contract annotations are added in Task 2 and verified by Task 1's test (which is written first).
- The renderer in Task 1 is a real, standalone script — no placeholders, no "implement renderer here" stubs.
- Migration to `AIContext` is referenced for context but explicitly out of scope; no migration tasks are present.
- The `cluster.local` DNS suffix in `a2a-endpoint` assumes the standard K8s cluster DNS. If your cluster uses a non-standard suffix, adjust both the template and the Layer 1 test assertion.
- Tasks 1 and 2 must execute in order (Task 1 establishes the failing test that Task 2 makes pass). Tasks 3 and 4 are independent and could be parallelized.
