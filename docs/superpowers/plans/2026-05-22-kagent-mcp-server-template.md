# Kagent MCP Server Scaffolder Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Backstage scaffolder template (`kagent-mcp-server`) that provisions kmcp `MCPServer` CRDs into `arigsela/kubernetes` via PR + ArgoCD, with a sibling decommission template. Curated v1 catalog: `server-everything`, `github-mcp-server`, and a `custom` free-form path.

**Architecture:** Mirrors the existing `kagent-agent` template pair. Two new templates under `examples/templates/`, two new TypeScript scaffolder actions in `packages/backend/src/modules/scaffolder/`, and an extended contract-test harness under `scripts/kagent-mcp-server-template/`. The renderer is generalized to accept a template path so both templates share it. Output lands at `base-apps/kagent/mcp-servers/<name>/{mcpserver.yaml,externalsecret.yaml}` (the secret file only when needed).

**Tech Stack:** Backstage scaffolder (Nunjucks templates with `${{ }}` tags + `dump`/`trim`/`indent` filters), TypeScript scaffolder actions using `@backstage/plugin-scaffolder-node` + `@octokit/rest`, Jest for action unit tests, bash + `yq` + `jq` for the contract test, Node `nunjucks` package for offline rendering.

**Companion spec:** [docs/superpowers/specs/2026-05-22-kagent-mcp-server-template-design.md](../specs/2026-05-22-kagent-mcp-server-template-design.md)

---

## Pre-implementation lookups

Before any code, resolve the two open questions the spec explicitly defers.

### Task 0: Resolve open implementation questions

**Files:**
- Read-only: cluster + `ghcr.io/github/github-mcp-server` image
- Create: `docs/plans/kagent-mcp-server-lookups.md` (notes file, deleted on plan completion)

- [ ] **Step 1: Resolve `github-mcp-server` HTTP cmd/args**

Run:
```bash
docker pull ghcr.io/github/github-mcp-server:latest
docker inspect ghcr.io/github/github-mcp-server:latest \
  --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'
```
Expected: prints the entrypoint and cmd. Cross-reference with `https://github.com/github/github-mcp-server/blob/main/README.md` HTTP-mode docs to identify the flag that enables `streamable_http` (typically `http-server` subcommand or `--port` flag).

Record the result in `docs/plans/kagent-mcp-server-lookups.md` under heading "github-mcp-server entrypoint":
```
ENTRYPOINT: <verbatim from inspect>
CMD:        <verbatim from inspect>
HTTP flag:  <e.g. "stdio" / "http-server" / "--http" with reference URL>
```

- [ ] **Step 2: Resolve `ClusterSecretStore` name**

Run:
```bash
kubectl get clustersecretstore -o name
kubectl get -n backstage externalsecret -o yaml | grep -A2 "secretStoreRef:" | head -20
```
Expected: lists the cluster-wide SecretStore. Find the one the `backstage` namespace already uses for Vault.

Record in the lookups file under heading "ClusterSecretStore":
```
Name: <verified-name>
Verified via: kubectl get clustersecretstore + cross-ref with base-apps/backstage/external-secret.yaml in arigsela/kubernetes
```

- [ ] **Step 3: Commit lookups note**

```bash
git add docs/plans/kagent-mcp-server-lookups.md
git commit -m "docs(plan): record pre-implementation lookups for kagent-mcp-server template"
```

These notes inform later task's hard-coded values. Delete the file in the final cleanup task.

---

## File structure overview

```
examples/templates/kagent-mcp-server/
├── template.yaml                                                    # wizard + steps
└── content/
    ├── base/
    │   └── base-apps/kagent/mcp-servers/${{ values.name }}/
    │       └── mcpserver.yaml                                       # always rendered
    └── with-secret/
        └── base-apps/kagent/mcp-servers/${{ values.name }}/
            └── externalsecret.yaml                                  # conditional

examples/templates/kagent-mcp-server-decommission/
└── template.yaml

packages/backend/src/modules/scaffolder/
├── kagentMcpServerValidateNameAction.ts                             # ~100 lines
├── kagentMcpServerValidateNameAction.test.ts
├── kagentMcpServerDecommissionAction.ts                             # ~280 lines
├── kagentMcpServerDecommissionAction.test.ts
└── index.ts                                                         # register new actions

scripts/kagent-mcp-server-template/
├── render.js                                                        # generalized clone of kagent-template/render.js
├── test-contract.sh                                                 # assertion-based, like kagent-template
└── fixtures/
    ├── server-everything.json
    ├── github-mcp-server.json
    ├── custom-stdio.json
    ├── custom-http-with-secret.json
    └── custom-extraenv-only.json
```

Each file has one responsibility. `mcpserver.yaml` and `externalsecret.yaml` are split so the optional one can be guarded by a step `if:`. Actions are split per concern (validate vs decommission) and per file size.

---

## Phase 1 — Generalize the offline renderer

The existing `scripts/kagent-template/render.js` hard-codes the agent template path. We need it to accept any template file path so the new contract test can reuse it.

### Task 1.1: Generalize render.js

**Files:**
- Modify: `scripts/kagent-template/render.js:14-17`

- [ ] **Step 1: Read the current renderer**

Run: `cat scripts/kagent-template/render.js`
Confirm: TEMPLATE_PATH is hard-coded to the agent template (lines 14-18).

- [ ] **Step 2: Generalize to take template path as CLI arg**

Edit `scripts/kagent-template/render.js`. Replace lines 14-27 with:

```javascript
const REPO_ROOT = path.resolve(__dirname, '../..');

// Usage: node render.js <template-path-relative-to-repo-root> <fixture.json>
// Back-compat: when only one arg is given, default to the agent template.
const argTemplate = process.argv[2];
const argFixture = process.argv[3];

let templatePath;
let fixturePath;

if (argFixture) {
  templatePath = path.resolve(REPO_ROOT, argTemplate);
  fixturePath = argFixture;
} else {
  // Back-compat: single-arg form keeps the agent contract test working.
  templatePath = path.join(
    REPO_ROOT,
    'examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml',
  );
  fixturePath = argTemplate;
}

if (!fixturePath) {
  console.error(
    'Usage: node render.js <template-path> <fixture.json>\n' +
    '       node render.js <fixture.json>   # agent template (back-compat)',
  );
  process.exit(2);
}
```

And change line 27 (`const templateSource = fs.readFileSync(TEMPLATE_PATH, 'utf8');`) to:

```javascript
const templateSource = fs.readFileSync(templatePath, 'utf8');
```

Also delete the original `TEMPLATE_PATH` constant block (the old lines 14-18 that you replaced).

- [ ] **Step 3: Verify back-compat with the agent contract test**

Run: `bash scripts/kagent-template/test-contract.sh`
Expected: `All fixtures passed.` exit 0. Same output as before this change.

- [ ] **Step 4: Verify the two-arg form with a quick smoke**

Run:
```bash
echo '{"name":"smoke-test","description":"hi","owner":"user:default/me","systemMessage":"You are helpful.","includeBuiltinPrompts":true,"delegateAgents":[],"skills":[],"cpuRequest":"100m","cpuLimit":"1000m","memoryRequest":"256Mi","memoryLimit":"1Gi","compactionInterval":5,"overlapSize":2}' > /tmp/smoke.json
node scripts/kagent-template/render.js 'examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml' /tmp/smoke.json | head -5
```
Expected: First few lines of a rendered Agent YAML.

- [ ] **Step 5: Commit**

```bash
git add scripts/kagent-template/render.js
git commit -m "refactor(scripts): generalize kagent-template render.js to accept template path arg

Preserves single-arg back-compat for the existing agent contract test.
Two-arg form lets a sibling MCP-server template reuse the same Nunjucks
config without duplicating the renderer."
```

---

## Phase 2 — `kagent:mcp-server:validate-name` action (TDD)

Copy of `kagentValidateNameAction.ts` with the scan path changed to `base-apps/kagent/mcp-servers/`. The agent action's `fileExists` helper already handles both file (404 on file) and folder (404 on folder) lookups correctly because `octokit.repos.getContent` 404s on a missing path regardless of type.

### Task 2.1: Write the action

**Files:**
- Read: `packages/backend/src/modules/scaffolder/kagentValidateNameAction.ts`
- Create: `packages/backend/src/modules/scaffolder/kagentMcpServerValidateNameAction.ts`

- [ ] **Step 1: Re-read the agent validator as the reference**

Run: `cat packages/backend/src/modules/scaffolder/kagentValidateNameAction.ts`
Note the action ID, the two paths checked, and the error message style.

- [ ] **Step 2: Create the MCP-server validator**

Create `packages/backend/src/modules/scaffolder/kagentMcpServerValidateNameAction.ts`:

```typescript
/**
 * Custom Scaffolder Action: kagent:mcp-server:validate-name
 * ==========================================================
 *
 * Validates that the proposed kagent MCPServer name does not collide with an
 * existing resource at either:
 *   - base-apps/kagent/mcp-servers/<name>/         (folder for IDP-managed servers)
 *   - base-apps/kagent/mcp-servers/<name>.yaml     (legacy/manual files)
 *
 * Throws with a clear error if either exists. Fails the wizard before
 * publish:github:pull-request would conflict.
 *
 * AUTHENTICATION:
 * Reads process.env.GITHUB_TOKEN. Same token used by other Octokit actions.
 *
 * Companion spec: docs/superpowers/specs/2026-05-22-kagent-mcp-server-template-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Octokit } from '@octokit/rest';

const OWNER = 'arigsela';
const REPO = 'kubernetes';
const MCP_SERVERS_DIR = 'base-apps/kagent/mcp-servers';

function isHttpError(err: unknown): err is { status: number; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as any).status === 'number'
  );
}

async function pathExists(octokit: Octokit, path: string): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    return true;
  } catch (err) {
    if (isHttpError(err) && err.status === 404) {
      return false;
    }
    throw err;
  }
}

export function createKagentMcpServerValidateNameAction() {
  return createTemplateAction({
    id: 'kagent:mcp-server:validate-name',
    description:
      'Fails if a kagent MCPServer with the given name already exists at either base-apps/kagent/mcp-servers/<name>/ or base-apps/kagent/mcp-servers/<name>.yaml.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/)
            .describe(
              'Proposed kagent MCPServer name (lowercase, hyphens, 4-40 chars).',
            ),
      },
    },

    async handler(ctx) {
      const { name } = ctx.input as { name: string };

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error(
          'GITHUB_TOKEN env var is not set. Required for kagent:mcp-server:validate-name.',
        );
      }

      const octokit = new Octokit({ auth: token });
      const folderPath = `${MCP_SERVERS_DIR}/${name}`;
      const legacyFilePath = `${MCP_SERVERS_DIR}/${name}.yaml`;

      ctx.logger.info(
        `kagent:mcp-server:validate-name — Checking for collisions on '${name}'`,
      );

      if (await pathExists(octokit, folderPath)) {
        throw new Error(
          `MCPServer '${name}' already exists at ${folderPath}/. Choose a different name.`,
        );
      }

      if (await pathExists(octokit, legacyFilePath)) {
        throw new Error(
          `MCPServer '${name}' already exists at ${legacyFilePath}. Choose a different name.`,
        );
      }

      ctx.logger.info(
        `kagent:mcp-server:validate-name — Name '${name}' is available.`,
      );
    },
  });
}
```

### Task 2.2: Write the tests

**Files:**
- Read: `packages/backend/src/modules/scaffolder/kagentValidateNameAction.test.ts`
- Create: `packages/backend/src/modules/scaffolder/kagentMcpServerValidateNameAction.test.ts`

- [ ] **Step 1: Read the agent validator tests as a reference**

Run: `cat packages/backend/src/modules/scaffolder/kagentValidateNameAction.test.ts`
Note the Octokit mock pattern (`jest.mock('@octokit/rest', ...)`) and the test cases covered.

- [ ] **Step 2: Create the test file mirroring the agent shape**

Create `packages/backend/src/modules/scaffolder/kagentMcpServerValidateNameAction.test.ts`:

```typescript
/**
 * Unit tests for kagent:mcp-server:validate-name.
 *
 * Mocks @octokit/rest's repos.getContent to simulate folder/file existence
 * and verifies the action throws clear errors on collision.
 */

import { createKagentMcpServerValidateNameAction } from './kagentMcpServerValidateNameAction';

const mockGetContent = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      getContent: mockGetContent,
    },
  })),
}));

const baseCtx = () => ({
  input: { name: 'test-mcp' },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  output: jest.fn(),
}) as any;

describe('kagent:mcp-server:validate-name', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghs_test-token';
    mockGetContent.mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toThrow(
      /GITHUB_TOKEN env var is not set/,
    );
  });

  it('passes when neither folder nor legacy file exists', async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).resolves.toBeUndefined();
    expect(mockGetContent).toHaveBeenCalledTimes(2);
    expect(mockGetContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'base-apps/kagent/mcp-servers/test-mcp',
      }),
    );
    expect(mockGetContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'base-apps/kagent/mcp-servers/test-mcp.yaml',
      }),
    );
  });

  it('throws when the IDP folder already exists', async () => {
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'base-apps/kagent/mcp-servers/test-mcp') {
        return { data: [] };
      }
      throw { status: 404 };
    });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toThrow(
      /already exists at base-apps\/kagent\/mcp-servers\/test-mcp\//,
    );
  });

  it('throws when the legacy file already exists', async () => {
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'base-apps/kagent/mcp-servers/test-mcp.yaml') {
        return { data: { type: 'file' } };
      }
      throw { status: 404 };
    });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toThrow(
      /already exists at base-apps\/kagent\/mcp-servers\/test-mcp\.yaml/,
    );
  });

  it('propagates non-404 errors from Octokit', async () => {
    mockGetContent.mockRejectedValue({ status: 500, message: 'GitHub down' });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toMatchObject({
      status: 500,
    });
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `yarn workspace backend test --testPathPattern=kagentMcpServerValidateName`
Expected: 5 tests, all pass.

If yarn complains the test file doesn't compile due to a Jest config, check whether `packages/backend/jest.config.*` exists and matches the agent test's discovery pattern. The new file lives in the same directory as the agent test — same config will pick it up.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/modules/scaffolder/kagentMcpServerValidateNameAction.ts \
        packages/backend/src/modules/scaffolder/kagentMcpServerValidateNameAction.test.ts
git commit -m "feat(scaffolder): add kagent:mcp-server:validate-name action

Mirrors kagent:agent:validate-name but scans base-apps/kagent/mcp-servers/
for both folder collisions (IDP-managed) and legacy <name>.yaml files."
```

### Task 2.3: Register the new action

**Files:**
- Modify: `packages/backend/src/modules/scaffolder/index.ts`

- [ ] **Step 1: Add import and registration**

Edit `packages/backend/src/modules/scaffolder/index.ts`. After line 29 (`import { createKagentInvokeAction } ...`), add:

```typescript
import { createKagentMcpServerValidateNameAction } from './kagentMcpServerValidateNameAction';
```

After line 50 (`createKagentDecommissionAction(),`), add:

```typescript
          createKagentMcpServerValidateNameAction(),
```

Then update the doc comment block (lines 8-18). Add a line after the kagent:agent:invoke entry:

```
 * - kagent:mcp-server:validate-name — Fails the wizard on MCPServer name collisions
```

- [ ] **Step 2: Type-check the backend**

Run: `yarn workspace backend tsc --noEmit`
Expected: no errors. If there are errors, they almost certainly mean the import path is wrong or a typo in the function name — fix and re-run.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/modules/scaffolder/index.ts
git commit -m "feat(scaffolder): register kagent:mcp-server:validate-name action"
```

---

## Phase 3 — MCP server template (base content)

Build the template skeleton + the always-rendered `mcpserver.yaml` for the `server-everything` and `custom` presets. The `github-mcp-server` preset path lands in Task 4 since it also needs the ExternalSecret. We do the contract test before the template so TDD drives the shape.

### Task 3.1: Fixtures

**Files:**
- Create: `scripts/kagent-mcp-server-template/fixtures/server-everything.json`
- Create: `scripts/kagent-mcp-server-template/fixtures/custom-stdio.json`
- Create: `scripts/kagent-mcp-server-template/fixtures/custom-extraenv-only.json`

- [ ] **Step 1: Create the fixtures directory**

Run: `mkdir -p scripts/kagent-mcp-server-template/fixtures`

- [ ] **Step 2: Write `server-everything.json`**

Create `scripts/kagent-mcp-server-template/fixtures/server-everything.json`:

```json
{
  "name": "everything-test",
  "description": "Reference MCP server used to smoke-test the template.",
  "owner": "group:default/platform-engineering",
  "preset": "server-everything",
  "githubToolsets": [],
  "image": "",
  "cmd": "",
  "args": [],
  "transportType": "stdio",
  "port": null,
  "extraEnv": [],
  "vaultSecrets": [],
  "vaultPath": "",
  "vaultTokenKey": "",
  "cpuRequest": "100m",
  "cpuLimit": "500m",
  "memoryRequest": "128Mi",
  "memoryLimit": "512Mi"
}
```

- [ ] **Step 3: Write `custom-stdio.json`**

Create `scripts/kagent-mcp-server-template/fixtures/custom-stdio.json`:

```json
{
  "name": "context7",
  "description": "Documentation lookup MCP server via npx.",
  "owner": "user:default/arisela",
  "preset": "custom",
  "githubToolsets": [],
  "image": "",
  "cmd": "npx",
  "args": ["-y", "@upstash/context7-mcp@latest"],
  "transportType": "stdio",
  "port": null,
  "extraEnv": [],
  "vaultSecrets": [],
  "vaultPath": "",
  "vaultTokenKey": "",
  "cpuRequest": "100m",
  "cpuLimit": "500m",
  "memoryRequest": "128Mi",
  "memoryLimit": "512Mi"
}
```

- [ ] **Step 4: Write `custom-extraenv-only.json`**

Create `scripts/kagent-mcp-server-template/fixtures/custom-extraenv-only.json`:

```json
{
  "name": "custom-env-test",
  "description": "Stdio MCP server with literal env vars (no secrets).",
  "owner": "user:default/arisela",
  "preset": "custom",
  "githubToolsets": [],
  "image": "python:3.12-slim",
  "cmd": "python",
  "args": ["-m", "my_mcp_server"],
  "transportType": "stdio",
  "port": null,
  "extraEnv": [
    { "name": "LOG_LEVEL", "value": "info" },
    { "name": "API_BASE_URL", "value": "https://api.example.com" }
  ],
  "vaultSecrets": [],
  "vaultPath": "",
  "vaultTokenKey": "",
  "cpuRequest": "100m",
  "cpuLimit": "500m",
  "memoryRequest": "128Mi",
  "memoryLimit": "512Mi"
}
```

- [ ] **Step 5: Commit**

```bash
git add scripts/kagent-mcp-server-template/fixtures/
git commit -m "test(kagent-mcp-server): add fixtures for stdio presets"
```

### Task 3.2: Contract test (assertions only — initial pass)

Mirrors `scripts/kagent-template/test-contract.sh` but asserts MCPServer-specific properties. Golden-file diffs are deliberately *not* used — keeps the test resilient to cosmetic YAML changes (trailing whitespace, ordering).

**Files:**
- Create: `scripts/kagent-mcp-server-template/test-contract.sh`

- [ ] **Step 1: Write the contract test**

Create `scripts/kagent-mcp-server-template/test-contract.sh`:

```bash
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
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/kagent-mcp-server-template/test-contract.sh`

- [ ] **Step 3: Run it (expected to fail — templates don't exist yet)**

Run: `bash scripts/kagent-mcp-server-template/test-contract.sh`
Expected: fails because `examples/templates/kagent-mcp-server/...` doesn't exist yet. The error should mention "ENOENT" or "No such file".

This is correct TDD — we have the assertion harness ready before the template.

- [ ] **Step 4: Commit**

```bash
git add scripts/kagent-mcp-server-template/test-contract.sh
git commit -m "test(kagent-mcp-server): add contract test harness with structural assertions"
```

### Task 3.3: Write the template content for `mcpserver.yaml`

**Files:**
- Create: `examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml`

- [ ] **Step 1: Create the directory tree**

Run:
```bash
mkdir -p 'examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}'
```
Note the single-quotes — the literal `${{ values.name }}` is part of the path.

- [ ] **Step 2: Write the template**

Create `examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml`:

```yaml
apiVersion: kagent.dev/v1alpha1
kind: MCPServer
metadata:
  name: ${{ values.name }}
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
    app.kubernetes.io/managed-by: kagent
    app.kubernetes.io/name: ${{ values.name }}
    arigsela.com/idp-managed: "true"
  annotations:
    backstage.io/managed-by-location: url:https://github.com/arigsela/kubernetes/blob/main/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml
    backstage.io/owner: ${{ values.owner }}
spec:
{%- if values.preset == "server-everything" %}
  transportType: stdio
  deployment:
    cmd: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-everything@latest"
    resources:
      requests:
        cpu: ${{ values.cpuRequest }}
        memory: ${{ values.memoryRequest }}
      limits:
        cpu: ${{ values.cpuLimit }}
        memory: ${{ values.memoryLimit }}
{%- elif values.preset == "github-mcp-server" %}
  transportType: streamable_http
  deployment:
    port: 8080
    image: ghcr.io/github/github-mcp-server:latest
    # cmd/args resolved from Task 0 lookup — fill in before merge.
    cmd: ""
    args: []
    env:
      - name: GITHUB_PERSONAL_ACCESS_TOKEN
        valueFrom:
          secretKeyRef:
            name: ${{ values.name }}-github-token
            key: github-token
{%- if values.githubToolsets and values.githubToolsets | length > 0 %}
      - name: GITHUB_TOOLSETS
        value: "${{ values.githubToolsets | join(',') }}"
{%- endif %}
    resources:
      requests:
        cpu: ${{ values.cpuRequest }}
        memory: ${{ values.memoryRequest }}
      limits:
        cpu: ${{ values.cpuLimit }}
        memory: ${{ values.memoryLimit }}
{%- elif values.preset == "custom" %}
  transportType: ${{ values.transportType }}
  deployment:
{%- if values.image %}
    image: ${{ values.image }}
{%- endif %}
    cmd: ${{ values.cmd }}
{%- if values.args and values.args | length > 0 %}
    args:
{%- for a in values.args %}
      - ${{ a | dump }}
{%- endfor %}
{%- endif %}
{%- if values.transportType != "stdio" and values.port %}
    port: ${{ values.port }}
{%- endif %}
{%- set has_extra = values.extraEnv and (values.extraEnv | length > 0) %}
{%- set has_vault = values.vaultSecrets and (values.vaultSecrets | length > 0) %}
{%- if has_extra or has_vault %}
    env:
{%- for e in values.extraEnv %}
      - name: ${{ e.name }}
        value: ${{ e.value | dump }}
{%- endfor %}
{%- for s in values.vaultSecrets %}
      - name: ${{ s.envName }}
        valueFrom:
          secretKeyRef:
            name: ${{ values.name }}-secrets
            key: ${{ s.envName | lower }}
{%- endfor %}
{%- endif %}
    resources:
      requests:
        cpu: ${{ values.cpuRequest }}
        memory: ${{ values.memoryRequest }}
      limits:
        cpu: ${{ values.cpuLimit }}
        memory: ${{ values.memoryLimit }}
{%- endif %}
```

> **Note for executor:** The `cmd: ""` and `args: []` in the github-mcp-server branch are *placeholders* that the Task 0 lookup must fill in before this template is usable in production. Wire that in during Task 4.2.

- [ ] **Step 3: Run the contract test**

Run: `bash scripts/kagent-mcp-server-template/test-contract.sh`
Expected: all three current fixtures (`server-everything`, `custom-stdio`, `custom-extraenv-only`) pass. The github and `custom-http-with-secret` fixtures don't exist yet (Task 4).

If any assertion fails: re-read the assertion message in the test output, examine the rendered YAML by running `node scripts/kagent-template/render.js 'examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml' scripts/kagent-mcp-server-template/fixtures/server-everything.json`, and adjust the template.

- [ ] **Step 4: Commit**

```bash
git add examples/templates/kagent-mcp-server/content/base/
git commit -m "feat(kagent-mcp-server): add mcpserver.yaml template body for stdio presets

server-everything renders a fixed npx invocation; custom renders user-provided
image/cmd/args/env. github-mcp-server scaffolding is in place with cmd/args
placeholders to be filled in by the Task 0 lookup."
```

---

## Phase 4 — ExternalSecret content and github preset

### Task 4.1: Add the remaining fixtures

**Files:**
- Create: `scripts/kagent-mcp-server-template/fixtures/github-mcp-server.json`
- Create: `scripts/kagent-mcp-server-template/fixtures/custom-http-with-secret.json`

- [ ] **Step 1: Write `github-mcp-server.json`**

Create `scripts/kagent-mcp-server-template/fixtures/github-mcp-server.json`:

```json
{
  "name": "github-pr-bot",
  "description": "GitHub MCP server for PR and issue operations.",
  "owner": "group:default/platform-engineering",
  "preset": "github-mcp-server",
  "githubToolsets": ["repos", "issues", "pull_requests"],
  "image": "",
  "cmd": "",
  "args": [],
  "transportType": "streamable_http",
  "port": 8080,
  "extraEnv": [],
  "vaultSecrets": [],
  "vaultPath": "kagent/mcp-servers/github-pr-bot",
  "vaultTokenKey": "github-token",
  "cpuRequest": "100m",
  "cpuLimit": "500m",
  "memoryRequest": "128Mi",
  "memoryLimit": "512Mi"
}
```

- [ ] **Step 2: Write `custom-http-with-secret.json`**

Create `scripts/kagent-mcp-server-template/fixtures/custom-http-with-secret.json`:

```json
{
  "name": "private-tool-server",
  "description": "Internal MCP server with API key from Vault.",
  "owner": "user:default/arisela",
  "preset": "custom",
  "githubToolsets": [],
  "image": "ghcr.io/acme/private-mcp:1.2.0",
  "cmd": "/server",
  "args": ["--http"],
  "transportType": "streamable_http",
  "port": 9090,
  "extraEnv": [
    { "name": "LOG_LEVEL", "value": "info" }
  ],
  "vaultSecrets": [
    {
      "envName": "ACME_API_KEY",
      "vaultPath": "kagent/mcp-servers/private-tool-server",
      "vaultKey": "api-key"
    },
    {
      "envName": "ACME_DB_PASSWORD",
      "vaultPath": "kagent/mcp-servers/private-tool-server",
      "vaultKey": "db-password"
    }
  ],
  "vaultPath": "",
  "vaultTokenKey": "",
  "cpuRequest": "100m",
  "cpuLimit": "500m",
  "memoryRequest": "128Mi",
  "memoryLimit": "512Mi"
}
```

### Task 4.2: Apply the Task 0 lookup to the github-mcp-server template

**Files:**
- Modify: `examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml` — the github-mcp-server `elif` branch
- Reference: `docs/plans/kagent-mcp-server-lookups.md` (from Task 0)

- [ ] **Step 1: Read the lookups note**

Run: `cat docs/plans/kagent-mcp-server-lookups.md`
Find the "github-mcp-server entrypoint" heading. Note the resolved cmd, args, and HTTP-mode flag.

- [ ] **Step 2: Update the template**

Open `examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml` and replace the lines:

```yaml
    # cmd/args resolved from Task 0 lookup — fill in before merge.
    cmd: ""
    args: []
```

with the values resolved in Task 0 (illustrative; actual values come from the lookup):

```yaml
    cmd: /server
    args:
      - http-server
      - "--port=8080"
```

If the upstream image uses a different invocation, use the exact strings from the lookups note.

- [ ] **Step 3: Run the contract test against the github fixture**

Run: `bash scripts/kagent-mcp-server-template/test-contract.sh`
Expected: the `github-mcp-server` fixture's mcpserver.yaml assertions pass (image, secretKeyRef, transportType). The externalsecret check still fails because that file doesn't exist yet.

- [ ] **Step 4: Commit**

```bash
git add scripts/kagent-mcp-server-template/fixtures/github-mcp-server.json \
        scripts/kagent-mcp-server-template/fixtures/custom-http-with-secret.json \
        'examples/templates/kagent-mcp-server/content/base/base-apps/kagent/mcp-servers/${{ values.name }}/mcpserver.yaml'
git commit -m "feat(kagent-mcp-server): fill in github-mcp-server cmd/args and add HTTP fixtures"
```

### Task 4.3: Write the ExternalSecret template

**Files:**
- Create: `examples/templates/kagent-mcp-server/content/with-secret/base-apps/kagent/mcp-servers/${{ values.name }}/externalsecret.yaml`

- [ ] **Step 1: Create the directory tree**

Run:
```bash
mkdir -p 'examples/templates/kagent-mcp-server/content/with-secret/base-apps/kagent/mcp-servers/${{ values.name }}'
```

- [ ] **Step 2: Write the externalsecret template**

Create `examples/templates/kagent-mcp-server/content/with-secret/base-apps/kagent/mcp-servers/${{ values.name }}/externalsecret.yaml`. Replace `<CSS-NAME>` below with the value from Task 0 lookup's "ClusterSecretStore" heading.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
{%- if values.preset == "github-mcp-server" %}
  name: ${{ values.name }}-github-token
{%- else %}
  name: ${{ values.name }}-secrets
{%- endif %}
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
    app.kubernetes.io/name: ${{ values.name }}
    arigsela.com/idp-managed: "true"
  annotations:
    backstage.io/managed-by-location: url:https://github.com/arigsela/kubernetes/blob/main/base-apps/kagent/mcp-servers/${{ values.name }}/externalsecret.yaml
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: <CSS-NAME>
    kind: ClusterSecretStore
  target:
{%- if values.preset == "github-mcp-server" %}
    name: ${{ values.name }}-github-token
{%- else %}
    name: ${{ values.name }}-secrets
{%- endif %}
    creationPolicy: Owner
  data:
{%- if values.preset == "github-mcp-server" %}
    - secretKey: github-token
      remoteRef:
        key: ${{ values.vaultPath }}
        property: ${{ values.vaultTokenKey }}
{%- else %}
{%- for s in values.vaultSecrets %}
    - secretKey: ${{ s.envName | lower }}
      remoteRef:
        key: ${{ s.vaultPath }}
        property: ${{ s.vaultKey }}
{%- endfor %}
{%- endif %}
```

- [ ] **Step 3: Run the contract test**

Run: `bash scripts/kagent-mcp-server-template/test-contract.sh`
Expected: all five fixtures pass.

Look for:
- `github-mcp-server`: externalsecret target.name == `github-pr-bot-github-token` ✓
- `custom-http-with-secret`: externalsecret target.name == `private-tool-server-secrets` ✓, two `data[]` entries ✓
- The other three fixtures: no externalsecret rendered (test should skip them via `needs_externalsecret`) ✓

- [ ] **Step 4: Commit**

```bash
git add 'examples/templates/kagent-mcp-server/content/with-secret/'
git commit -m "feat(kagent-mcp-server): add externalsecret.yaml template for vault-backed secrets

Rendered only when preset=github-mcp-server or preset=custom with non-empty
vaultSecrets. github uses a fixed (target.name, secretKey) pair; custom
fans out one data[] entry per vaultSecrets item, with secretKey lowercased
from envName."
```

---

## Phase 5 — Wizard schema and steps pipeline

The wizard and steps go in `template.yaml` at the root of the new template.

### Task 5: Write `kagent-mcp-server/template.yaml`

**Files:**
- Create: `examples/templates/kagent-mcp-server/template.yaml`

- [ ] **Step 1: Skim the agent template for reference**

Run: `cat examples/templates/kagent-agent/template.yaml | head -50`
Note the apiVersion, metadata.tags, owner, parameters/steps structure.

- [ ] **Step 2: Write the new template.yaml**

Create `examples/templates/kagent-mcp-server/template.yaml`:

```yaml
# ==============================================================================
# Kagent MCP Server — Backstage Software Template
# ==============================================================================
#
# Self-service wizard for deploying a kmcp MCPServer CRD into the cluster.
# Renders into base-apps/kagent/mcp-servers/<name>/ in arigsela/kubernetes.
# ArgoCD's kagent-secrets app auto-syncs the new folder.
#
# Companion spec: docs/superpowers/specs/2026-05-22-kagent-mcp-server-template-design.md
# Wizard pages:
#   1. Identity (name, description, owner)
#   2. Preset (server-everything | github-mcp-server | custom)
#   3a/3b/3c. Per-preset config (mutually exclusive via oneOf)
#   4. Resources (CPU/memory, all defaulted)
#   5. Publish (dryRun toggle)
# ==============================================================================

apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: kagent-mcp-server-template
  title: Kagent MCP Server
  description: >-
    Deploy a kmcp MCPServer (Pod-backed MCP server) into the kagent cluster.
    Curated catalog includes server-everything and github-mcp-server; the
    'custom' preset accepts any image + cmd + args. Secrets flow from Vault
    via ExternalSecret.
  tags:
    - kagent
    - mcp-server
    - recommended

spec:
  owner: group:platform-engineering
  type: service

  parameters:
    # --- WIZARD PAGE 1: Identity ---
    - title: Identity
      required: [name, description, owner]
      properties:
        name:
          title: MCP server name
          type: string
          description: >-
            Lowercase, hyphens, 4-40 chars. Becomes both the folder name under
            base-apps/kagent/mcp-servers/ and the CRD metadata.name.
          pattern: "^[a-z][a-z0-9-]{2,38}[a-z0-9]$"
          ui:autofocus: true
          ui:help: "Example: github-pr-bot"
        description:
          title: Description
          type: string
          description: One sentence describing what this MCP server does.
          ui:options:
            rows: 2
        owner:
          title: Owner
          type: string
          description: Backstage Group or User that owns this MCP server.
          ui:field: EntityPicker
          ui:options:
            catalogFilter:
              kind: [Group, User]

    # --- WIZARD PAGE 2: Preset selection ---
    - title: Choose a preset
      required: [preset]
      properties:
        preset:
          title: Preset
          type: string
          description: >-
            Pick a curated MCP server (server-everything for smoke testing,
            github-mcp-server for GitHub operations) or 'custom' to BYO image.
          enum:
            - server-everything
            - github-mcp-server
            - custom
          enumNames:
            - "Server Everything (reference / smoke test, no secrets)"
            - "GitHub MCP Server (PAT from Vault)"
            - "Custom (BYO image + cmd + args)"
          ui:widget: radio
          default: server-everything

    # --- WIZARD PAGE 3a: github-mcp-server configuration ---
    - title: GitHub MCP server configuration
      if: ${{ parameters.preset === "github-mcp-server" }}
      required: [vaultPath, vaultTokenKey]
      properties:
        vaultPath:
          title: Vault path
          type: string
          description: >-
            Vault KV path where the PAT is stored.
          default: "kagent/mcp-servers/<name>"
          ui:help: >-
            Replace <name> with your MCP server name. The Vault entry must
            exist BEFORE the ExternalSecret syncs.
        vaultTokenKey:
          title: Vault property holding the token
          type: string
          default: "github-token"
        githubToolsets:
          title: Restrict to these toolsets (optional)
          type: array
          default: []
          description: >-
            Empty = all toolsets. Otherwise comma-joined into GITHUB_TOOLSETS env.
          items:
            type: string
            enum:
              - repos
              - issues
              - pull_requests
              - actions
              - code_security
          uniqueItems: true
          ui:widget: checkboxes

    # --- WIZARD PAGE 3b: custom server configuration ---
    - title: Custom MCP server configuration
      if: ${{ parameters.preset === "custom" }}
      required: [cmd, transportType]
      properties:
        image:
          title: Container image
          type: string
          description: >-
            OCI image. Leave empty when using cmd=npx (kmcp's default node
            image will be used).
        cmd:
          title: Command (executable)
          type: string
          description: "Example: npx, python, /server"
        args:
          title: Command arguments
          type: array
          default: []
          items:
            type: string
        transportType:
          title: Transport type
          type: string
          enum:
            - stdio
            - streamable_http
            - sse
          default: stdio
          ui:widget: radio
        port:
          title: Port (required when transport is not stdio)
          type: integer
          description: HTTP port the MCP server listens on.
        extraEnv:
          title: Literal env vars (non-secret)
          type: array
          default: []
          items:
            type: object
            required: [name, value]
            properties:
              name:
                type: string
              value:
                type: string
        vaultSecrets:
          title: Env vars from Vault (each renders one ExternalSecret entry)
          type: array
          default: []
          items:
            type: object
            required: [envName, vaultPath, vaultKey]
            properties:
              envName:
                title: Env var name (will be lowercased into the Secret key)
                type: string
              vaultPath:
                title: Vault KV path
                type: string
              vaultKey:
                title: Vault property
                type: string

    # --- WIZARD PAGE 4: Resources (always shown, defaulted) ---
    - title: Resources (optional)
      properties:
        cpuRequest:
          type: string
          title: CPU request
          default: "100m"
        cpuLimit:
          type: string
          title: CPU limit
          default: "500m"
        memoryRequest:
          type: string
          title: Memory request
          default: "128Mi"
        memoryLimit:
          type: string
          title: Memory limit
          default: "512Mi"

    # --- WIZARD PAGE 5: Publish ---
    - title: Publish
      properties:
        dryRun:
          title: Dry run (testing mode)
          type: boolean
          description: >-
            When enabled, writes the rendered YAML to /tmp/backstage-scaffolder/<name>/
            instead of opening a PR.
          default: false

  steps:
    # Step 1: Reject duplicate names BEFORE rendering or opening a PR.
    - id: validate-name
      name: Verify MCP server name is available
      action: kagent:mcp-server:validate-name
      input:
        name: ${{ parameters.name | trim }}

    # Step 2: Render the MCPServer CRD (always).
    - id: fetch-base
      name: Render MCPServer manifest
      action: fetch:template
      input:
        url: ./content/base
        values:
          name: ${{ parameters.name | trim }}
          description: ${{ parameters.description | trim }}
          owner: ${{ parameters.owner | trim }}
          preset: ${{ parameters.preset }}
          githubToolsets: ${{ parameters.githubToolsets }}
          image: ${{ parameters.image }}
          cmd: ${{ parameters.cmd }}
          args: ${{ parameters.args }}
          transportType: ${{ parameters.transportType }}
          port: ${{ parameters.port }}
          extraEnv: ${{ parameters.extraEnv }}
          vaultSecrets: ${{ parameters.vaultSecrets }}
          cpuRequest: ${{ parameters.cpuRequest | trim }}
          cpuLimit: ${{ parameters.cpuLimit | trim }}
          memoryRequest: ${{ parameters.memoryRequest | trim }}
          memoryLimit: ${{ parameters.memoryLimit | trim }}

    # Step 3: Render the ExternalSecret only when needed.
    - id: fetch-secret
      name: Render ExternalSecret manifest
      if: >-
        ${{ parameters.preset === "github-mcp-server"
            or (parameters.preset === "custom" and (parameters.vaultSecrets | length) > 0) }}
      action: fetch:template
      input:
        url: ./content/with-secret
        values:
          name: ${{ parameters.name | trim }}
          preset: ${{ parameters.preset }}
          vaultPath: ${{ parameters.vaultPath }}
          vaultTokenKey: ${{ parameters.vaultTokenKey }}
          vaultSecrets: ${{ parameters.vaultSecrets }}

    # Step 4 (production): Open PR against arigsela/kubernetes.
    - id: publish
      name: Open PR to arigsela/kubernetes
      if: ${{ not parameters.dryRun }}
      action: publish:github:pull-request
      input:
        repoUrl: github.com?owner=arigsela&repo=kubernetes
        branchName: scaffolder/add-mcp-server-${{ parameters.name | trim }}
        title: "feat(kagent): add ${{ parameters.name | trim }} MCP server"
        description: |
          Adds a new IDP-managed kagent kmcp `MCPServer`: `${{ parameters.name | trim }}`.
          Preset: `${{ parameters.preset }}`.

          ${{ parameters.description }}

          Generated by Backstage `kagent-mcp-server-template`.

    # Step 5 (dry run): Write to /tmp for offline testing.
    - id: publish-local
      name: Write to local filesystem (dry run)
      if: ${{ parameters.dryRun }}
      action: publish:file
      input:
        path: /tmp/backstage-scaffolder/${{ parameters.name | trim }}

  output:
    links:
      - title: Pull request
        url: ${{ steps.publish.output.remoteUrl }}
      - title: Dry run output
        url: file:///tmp/backstage-scaffolder/${{ parameters.name }}
```

- [ ] **Step 3: Validate the YAML parses**

Run: `yq eval '.' examples/templates/kagent-mcp-server/template.yaml > /dev/null`
Expected: no output, exit 0.

- [ ] **Step 4: Register the template in the catalog**

Find the file that lists template catalog locations:
```bash
grep -rn "kagent-agent/template.yaml" app-config*.yaml
```
Look at the surrounding `catalog.locations` block. Then add a sibling entry next to the existing kagent-agent template. Example pattern:

```yaml
    - type: file
      target: ../../examples/templates/kagent-mcp-server/template.yaml
      rules:
        - allow: [Template]
```

If the entries use a different path style (e.g. `${BACKSTAGE_ROOT}/examples/...`), match that style. Add to all app-config files where the agent template is registered (typically `app-config.yaml`; `app-config.production.yaml` may not need the change if it inherits).

- [ ] **Step 5: Commit**

```bash
git add examples/templates/kagent-mcp-server/template.yaml app-config*.yaml
git commit -m "feat(kagent-mcp-server): add wizard template.yaml and register in catalog

Five wizard pages with conditional pages 3a/3b via 'if:' on the parameter
group. Steps pipeline mirrors the agent template, with an additional
conditional fetch for the externalsecret.yaml."
```

---

## Phase 6 — Decommission action

Adapts `kagentDecommissionAction.ts` to delete a folder (multiple files) instead of a single file. Verifies the IDP label on each file before deleting.

### Task 6.1: Write the action

**Files:**
- Read: `packages/backend/src/modules/scaffolder/kagentDecommissionAction.ts`
- Create: `packages/backend/src/modules/scaffolder/kagentMcpServerDecommissionAction.ts`

- [ ] **Step 1: Re-read the agent decommission action**

Run: `cat packages/backend/src/modules/scaffolder/kagentDecommissionAction.ts`
Notice: it deletes one file, checks one label, builds a PR body specific to agents.

- [ ] **Step 2: Create the MCP-server decommission action**

Create `packages/backend/src/modules/scaffolder/kagentMcpServerDecommissionAction.ts`:

```typescript
/**
 * Custom Scaffolder Action: kagent:mcp-server:open-decommission-pr
 * =================================================================
 *
 * Opens a teardown PR for an IDP-managed kagent kmcp MCPServer by:
 *   1. Verifying the folder base-apps/kagent/mcp-servers/<name>/ exists
 *   2. Listing files in the folder (typically mcpserver.yaml [+ externalsecret.yaml])
 *   3. Verifying every file carries arigsela.com/idp-managed: "true" — refuses
 *      to touch hand-crafted MCP servers
 *   4. Creating a `scaffolder/decommission-mcp-server-<name>` branch from main
 *      (idempotent — reuse if exists)
 *   5. Deleting each file from the folder on that branch
 *   6. Opening a PR (idempotent — return existing PR if open)
 *
 * Post-merge: ArgoCD's `kagent-secrets` app prunes the MCPServer (and
 * ExternalSecret, if present); the kmcp controller tears down the Deployment
 * and Service automatically.
 *
 * AUTHENTICATION:
 * Reads process.env.GITHUB_TOKEN. Token needs `repo` scope on arigsela/kubernetes.
 *
 * Companion spec: docs/superpowers/specs/2026-05-22-kagent-mcp-server-template-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Octokit } from '@octokit/rest';

const OWNER = 'arigsela';
const REPO = 'kubernetes';
const BASE_BRANCH = 'main';
const MCP_SERVERS_DIR = 'base-apps/kagent/mcp-servers';
const IDP_MANAGED_LABEL = 'arigsela.com/idp-managed';
const IDP_MANAGED_VALUE = 'true';

function isHttpError(err: unknown): err is { status: number; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as any).status === 'number'
  );
}

function isIdpManaged(yamlBody: string): boolean {
  const pattern = new RegExp(
    `${IDP_MANAGED_LABEL.replace(/\./g, '\\.').replace(/\//g, '\\/')}:\\s*["']?${IDP_MANAGED_VALUE}["']?`,
  );
  return pattern.test(yamlBody);
}

function buildPrBody(name: string, files: string[]): string {
  return [
    `Decommissioning kagent MCPServer \`${name}\`.`,
    '',
    'Files removed:',
    ...files.map(f => `  - ${f}`),
    '',
    'After merge:',
    '1. ArgoCD `kagent-secrets` app prunes the MCPServer (and ExternalSecret if present) within ~3 min.',
    '2. The kmcp controller tears down the Deployment and Service automatically.',
    '',
    'No manual `kubectl delete` is required.',
    '',
    'Generated by Backstage `kagent-mcp-server-decommission` template.',
  ].join('\n');
}

export function createKagentMcpServerDecommissionAction() {
  return createTemplateAction({
    id: 'kagent:mcp-server:open-decommission-pr',
    description:
      'Opens a teardown PR for an IDP-managed kagent MCPServer. Verifies every file in the folder carries arigsela.com/idp-managed=true before deleting. Idempotent.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/)
            .describe(
              'MCP server name to tear down — must match an existing IDP-managed folder under base-apps/kagent/mcp-servers/',
            ),
      },
      output: {
        remoteUrl: z => z.string().describe('The PR URL on GitHub'),
        prNumber: z => z.number().describe('The PR number'),
        branchName: z => z.string().describe('The branch the teardown PR was opened from'),
      },
    },

    async handler(ctx) {
      const { name } = ctx.input as { name: string };

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error(
          'GITHUB_TOKEN env var is not set. Required for kagent:mcp-server:open-decommission-pr.',
        );
      }

      const octokit = new Octokit({ auth: token });
      const branchName = `scaffolder/decommission-mcp-server-${name}`;
      const folderPath = `${MCP_SERVERS_DIR}/${name}`;

      ctx.logger.info(
        `kagent:mcp-server:decommission — Starting decommission for ${name}`,
      );

      // Step 1: List folder contents on main
      let folderEntries: Array<{ path: string; name: string }>;
      try {
        const resp = await octokit.repos.getContent({
          owner: OWNER,
          repo: REPO,
          path: folderPath,
        });
        if (!Array.isArray(resp.data)) {
          throw new Error(
            `kagent:mcp-server:decommission — Expected ${folderPath} to be a folder, got ${typeof resp.data}`,
          );
        }
        folderEntries = resp.data
          .filter(e => e.type === 'file' && e.name.endsWith('.yaml'))
          .map(e => ({ path: e.path, name: e.name }));
      } catch (err) {
        if (isHttpError(err) && err.status === 404) {
          throw new Error(
            `MCP server '${name}' not found at ${folderPath}/. Either it was already decommissioned or it is hand-crafted.`,
          );
        }
        throw new Error(
          `kagent:mcp-server:decommission — Failed to list ${folderPath}: ${err instanceof Error ? err.message : String(err)}. Verify GITHUB_TOKEN has 'repo' scope.`,
        );
      }

      if (folderEntries.length === 0) {
        throw new Error(
          `MCP server '${name}' folder ${folderPath}/ is empty — nothing to decommission.`,
        );
      }

      // Step 2: Verify every file is IDP-managed
      for (const entry of folderEntries) {
        const resp = await octokit.repos.getContent({
          owner: OWNER,
          repo: REPO,
          path: entry.path,
        });
        const data = resp.data as { type?: string; content?: string };
        if (data.type !== 'file' || !data.content) {
          throw new Error(
            `kagent:mcp-server:decommission — Unexpected response shape for ${entry.path}`,
          );
        }
        const body = Buffer.from(data.content, 'base64').toString('utf-8');
        if (!isIdpManaged(body)) {
          throw new Error(
            `${entry.path} is not IDP-managed (missing label ${IDP_MANAGED_LABEL}=${IDP_MANAGED_VALUE}). Refusing to delete the whole folder. Tear down by hand.`,
          );
        }
      }

      // Step 3: Branch create or reuse
      let branchExists = false;
      try {
        await octokit.repos.getBranch({
          owner: OWNER,
          repo: REPO,
          branch: branchName,
        });
        branchExists = true;
        ctx.logger.info(
          `kagent:mcp-server:decommission — Reusing existing branch ${branchName}`,
        );
      } catch (err) {
        if (!isHttpError(err) || err.status !== 404) {
          throw err;
        }
      }

      if (!branchExists) {
        const mainRef = await octokit.git.getRef({
          owner: OWNER,
          repo: REPO,
          ref: `heads/${BASE_BRANCH}`,
        });
        await octokit.git.createRef({
          owner: OWNER,
          repo: REPO,
          ref: `refs/heads/${branchName}`,
          sha: mainRef.data.object.sha,
        });
        ctx.logger.info(`kagent:mcp-server:decommission — Created branch ${branchName}`);
      }

      // Step 4: Delete each file from the branch
      // Fetch SHA on the BRANCH for each delete (branch reuse may show different SHAs)
      const deletedPaths: string[] = [];
      for (const entry of folderEntries) {
        try {
          const onBranch = await octokit.repos.getContent({
            owner: OWNER,
            repo: REPO,
            path: entry.path,
            ref: branchName,
          });
          const sha = (onBranch.data as { sha?: string }).sha;
          if (!sha) {
            throw new Error(
              `kagent:mcp-server:decommission — No SHA for ${entry.path} on branch ${branchName}`,
            );
          }
          await octokit.repos.deleteFile({
            owner: OWNER,
            repo: REPO,
            path: entry.path,
            message: `chore(kagent): remove ${entry.name} for ${name}`,
            sha,
            branch: branchName,
          });
          deletedPaths.push(entry.path);
          ctx.logger.info(`kagent:mcp-server:decommission — Deleted ${entry.path}`);
        } catch (err) {
          if (isHttpError(err) && err.status === 404) {
            ctx.logger.warn(
              `kagent:mcp-server:decommission — ${entry.path} already missing on branch ${branchName}; continuing`,
            );
          } else {
            throw err;
          }
        }
      }

      // Step 5: Create or reuse PR
      const existingPrs = await octokit.pulls.list({
        owner: OWNER,
        repo: REPO,
        head: `${OWNER}:${branchName}`,
        state: 'open',
      });

      if (existingPrs.data.length > 0) {
        const pr = existingPrs.data[0];
        ctx.logger.info(
          `kagent:mcp-server:decommission — Reusing existing PR #${pr.number}`,
        );
        ctx.output('remoteUrl', pr.html_url);
        ctx.output('prNumber', pr.number);
        ctx.output('branchName', branchName);
        return;
      }

      try {
        const newPr = await octokit.pulls.create({
          owner: OWNER,
          repo: REPO,
          head: branchName,
          base: BASE_BRANCH,
          title: `chore(kagent): decommission ${name} MCP server`,
          body: buildPrBody(name, deletedPaths),
        });
        ctx.logger.info(
          `kagent:mcp-server:decommission — Created PR #${newPr.data.number}`,
        );
        ctx.output('remoteUrl', newPr.data.html_url);
        ctx.output('prNumber', newPr.data.number);
        ctx.output('branchName', branchName);
      } catch (err) {
        if (
          isHttpError(err) &&
          err.status === 422 &&
          err.message &&
          /already exists/i.test(err.message)
        ) {
          ctx.logger.warn(
            `kagent:mcp-server:decommission — PR create raced; re-listing`,
          );
          const recheck = await octokit.pulls.list({
            owner: OWNER,
            repo: REPO,
            head: `${OWNER}:${branchName}`,
            state: 'open',
          });
          if (recheck.data.length > 0) {
            const racePr = recheck.data[0];
            ctx.output('remoteUrl', racePr.html_url);
            ctx.output('prNumber', racePr.number);
            ctx.output('branchName', branchName);
            return;
          }
        }
        throw new Error(
          `kagent:mcp-server:decommission — Failed to create PR: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
    },
  });
}
```

### Task 6.2: Write the decommission tests

**Files:**
- Read: `packages/backend/src/modules/scaffolder/kagentDecommissionAction.test.ts`
- Create: `packages/backend/src/modules/scaffolder/kagentMcpServerDecommissionAction.test.ts`

- [ ] **Step 1: Read the existing agent decommission tests for shape**

Run: `cat packages/backend/src/modules/scaffolder/kagentDecommissionAction.test.ts`
Notice: `mockGetContent`, `mockGetBranch`, `mockGetRef`, `mockCreateRef`, `mockDeleteFile`, `mockListPulls`, `mockCreatePr` are mocked together.

- [ ] **Step 2: Create the MCP-server decommission tests**

Create `packages/backend/src/modules/scaffolder/kagentMcpServerDecommissionAction.test.ts`:

```typescript
/**
 * Unit tests for kagent:mcp-server:open-decommission-pr.
 *
 * Mocks Octokit's repos, git, and pulls endpoints to simulate the folder
 * walk + multi-file delete + PR creation flow.
 */

import { createKagentMcpServerDecommissionAction } from './kagentMcpServerDecommissionAction';

const mockGetContent = jest.fn();
const mockGetBranch = jest.fn();
const mockGetRef = jest.fn();
const mockCreateRef = jest.fn();
const mockDeleteFile = jest.fn();
const mockListPulls = jest.fn();
const mockCreatePr = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      getContent: mockGetContent,
      getBranch: mockGetBranch,
      deleteFile: mockDeleteFile,
    },
    git: {
      getRef: mockGetRef,
      createRef: mockCreateRef,
    },
    pulls: {
      list: mockListPulls,
      create: mockCreatePr,
    },
  })),
}));

const baseCtx = (name = 'test-mcp') =>
  ({
    input: { name },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    output: jest.fn(),
  }) as any;

// Helper to base64-encode a YAML body for getContent file responses.
const yamlBody = (idpManaged: boolean) =>
  Buffer.from(
    [
      'apiVersion: kagent.dev/v1alpha1',
      'kind: MCPServer',
      'metadata:',
      '  name: test-mcp',
      '  labels:',
      idpManaged ? '    arigsela.com/idp-managed: "true"' : '    app: other',
    ].join('\n'),
  ).toString('base64');

describe('kagent:mcp-server:open-decommission-pr', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghs_test-token';
    [
      mockGetContent,
      mockGetBranch,
      mockGetRef,
      mockCreateRef,
      mockDeleteFile,
      mockListPulls,
      mockCreatePr,
    ].forEach(m => m.mockReset());
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /GITHUB_TOKEN env var is not set/,
    );
  });

  it('throws when the folder is missing', async () => {
    mockGetContent.mockRejectedValueOnce({ status: 404 });
    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /not found at base-apps\/kagent\/mcp-servers\/test-mcp/,
    );
  });

  it('throws when the path is a file, not a folder', async () => {
    mockGetContent.mockResolvedValueOnce({ data: { type: 'file' } });
    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /Expected .* to be a folder/,
    );
  });

  it('refuses when any file is not IDP-managed', async () => {
    mockGetContent
      // listing the folder
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
          { type: 'file', name: 'externalsecret.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/externalsecret.yaml' },
        ],
      })
      // mcpserver.yaml — IDP-managed
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      // externalsecret.yaml — NOT IDP-managed
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(false) } });

    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /externalsecret\.yaml is not IDP-managed/,
    );
  });

  it('happy path deletes all files and opens a PR', async () => {
    mockGetContent
      // folder listing
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
          { type: 'file', name: 'externalsecret.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/externalsecret.yaml' },
        ],
      })
      // both files IDP-managed (label check)
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      // SHA fetches on the branch (one per file)
      .mockResolvedValueOnce({ data: { sha: 'aaaa' } })
      .mockResolvedValueOnce({ data: { sha: 'bbbb' } });

    mockGetBranch.mockRejectedValueOnce({ status: 404 });
    mockGetRef.mockResolvedValueOnce({ data: { object: { sha: 'mainsha' } } });
    mockCreateRef.mockResolvedValueOnce({});
    mockDeleteFile.mockResolvedValue({});
    mockListPulls.mockResolvedValueOnce({ data: [] });
    mockCreatePr.mockResolvedValueOnce({
      data: { number: 42, html_url: 'https://github.com/arigsela/kubernetes/pull/42' },
    });

    const ctx = baseCtx();
    const action = createKagentMcpServerDecommissionAction();
    await action.handler(ctx);

    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    expect(ctx.output).toHaveBeenCalledWith('remoteUrl', 'https://github.com/arigsela/kubernetes/pull/42');
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 42);
    expect(ctx.output).toHaveBeenCalledWith('branchName', 'scaffolder/decommission-mcp-server-test-mcp');
  });

  it('reuses an open PR if one exists', async () => {
    mockGetContent
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
        ],
      })
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      .mockResolvedValueOnce({ data: { sha: 'aaaa' } });
    mockGetBranch.mockResolvedValueOnce({}); // branch exists
    mockDeleteFile.mockResolvedValue({});
    mockListPulls.mockResolvedValueOnce({
      data: [{ number: 99, html_url: 'https://github.com/arigsela/kubernetes/pull/99' }],
    });

    const ctx = baseCtx();
    const action = createKagentMcpServerDecommissionAction();
    await action.handler(ctx);

    expect(mockCreatePr).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith('remoteUrl', 'https://github.com/arigsela/kubernetes/pull/99');
  });

  it('treats already-missing files as already-deleted and continues', async () => {
    mockGetContent
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
        ],
      })
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      // SHA fetch on branch → 404 (file already gone)
      .mockRejectedValueOnce({ status: 404 });
    mockGetBranch.mockResolvedValueOnce({});
    mockListPulls.mockResolvedValueOnce({ data: [] });
    mockCreatePr.mockResolvedValueOnce({
      data: { number: 7, html_url: 'https://example.com/pr/7' },
    });

    const ctx = baseCtx();
    const action = createKagentMcpServerDecommissionAction();
    await action.handler(ctx);

    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 7);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `yarn workspace backend test --testPathPattern=kagentMcpServerDecommission`
Expected: 6 tests, all pass. If any fail, examine the assertion message and adjust either the mock ordering or the action code.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/modules/scaffolder/kagentMcpServerDecommissionAction.ts \
        packages/backend/src/modules/scaffolder/kagentMcpServerDecommissionAction.test.ts
git commit -m "feat(scaffolder): add kagent:mcp-server:open-decommission-pr action

Deletes the whole base-apps/kagent/mcp-servers/<name>/ folder. Verifies
arigsela.com/idp-managed=true on every file before any delete. Idempotent
on branch and PR creation."
```

### Task 6.3: Register the decommission action

**Files:**
- Modify: `packages/backend/src/modules/scaffolder/index.ts`

- [ ] **Step 1: Add import and registration**

Open `packages/backend/src/modules/scaffolder/index.ts`. After the import added in Task 2.3:

```typescript
import { createKagentMcpServerDecommissionAction } from './kagentMcpServerDecommissionAction';
```

And after the `createKagentMcpServerValidateNameAction(),` line added earlier:

```typescript
          createKagentMcpServerDecommissionAction(),
```

Update the doc comment to add:
```
 * - kagent:mcp-server:open-decommission-pr — Opens a teardown PR for an IDP-managed MCPServer
```

- [ ] **Step 2: Type-check the backend**

Run: `yarn workspace backend tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/modules/scaffolder/index.ts
git commit -m "feat(scaffolder): register kagent:mcp-server:open-decommission-pr action"
```

---

## Phase 7 — Decommission template

### Task 7: Write the decommission template

**Files:**
- Create: `examples/templates/kagent-mcp-server-decommission/template.yaml`

- [ ] **Step 1: Skim the agent decommission template**

Run: `cat examples/templates/kagent-agent-decommission/template.yaml`

- [ ] **Step 2: Write the new decommission template**

Create `examples/templates/kagent-mcp-server-decommission/template.yaml`:

```yaml
# ==============================================================================
# Kagent MCP Server — Decommission
# ==============================================================================
#
# Opens a teardown PR that removes a Backstage-managed kagent kmcp MCPServer
# (and its ExternalSecret, if present). Refuses to delete servers that don't
# carry the arigsela.com/idp-managed label.
#
# Companion spec: docs/superpowers/specs/2026-05-22-kagent-mcp-server-template-design.md
# ==============================================================================

apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: kagent-mcp-server-decommission
  title: Decommission Kagent MCP Server
  description: >-
    Opens a teardown PR that removes a Backstage-managed kagent MCPServer
    (and its ExternalSecret). Refuses to delete servers that are not
    IDP-managed.
  tags:
    - kagent
    - mcp-server
    - decommission

spec:
  owner: group:platform-engineering
  type: service

  parameters:
    - title: Identity
      required: [name]
      properties:
        name:
          type: string
          title: MCP server name to tear down
          description: >-
            Must match an existing IDP-managed MCP server under
            base-apps/kagent/mcp-servers/.
          pattern: "^[a-z][a-z0-9-]{2,38}[a-z0-9]$"

  steps:
    - id: publish
      name: Open teardown PR
      action: kagent:mcp-server:open-decommission-pr
      input:
        name: ${{ parameters.name | trim }}

  output:
    links:
      - title: Teardown PR
        url: ${{ steps.publish.output.remoteUrl }}
```

- [ ] **Step 3: Validate YAML and register in catalog**

Run: `yq eval '.' examples/templates/kagent-mcp-server-decommission/template.yaml > /dev/null`
Expected: exit 0.

Then add a catalog entry alongside the main template:
```bash
grep -rn "kagent-agent-decommission/template.yaml" app-config*.yaml
```
Add a sibling entry for `kagent-mcp-server-decommission/template.yaml` in the same shape.

- [ ] **Step 4: Commit**

```bash
git add examples/templates/kagent-mcp-server-decommission/ app-config*.yaml
git commit -m "feat(kagent-mcp-server): add decommission template

Simple one-page wizard that takes the MCP server name and delegates
to kagent:mcp-server:open-decommission-pr."
```

---

## Phase 8 — Verification and cleanup

### Task 8.1: End-to-end dry-run verification

**Files:**
- None (manual verification)

- [ ] **Step 1: Build the backend**

Run: `yarn workspace backend build`
Expected: exit 0.

- [ ] **Step 2: Start the dev server**

Run: `yarn dev`
Expected: app starts on http://localhost:3000.

- [ ] **Step 3: Scaffold `server-everything` with dryRun=true**

In the browser, open Backstage → Create. Find "Kagent MCP Server". Fill in:
- name: `everything-test`
- description: `Smoke test`
- owner: `group:default/platform-engineering`
- preset: `server-everything`
- (skip pages 3a/3b)
- dryRun: `true`

Click Create. After completion, run:
```bash
ls /tmp/backstage-scaffolder/everything-test/
cat /tmp/backstage-scaffolder/everything-test/base-apps/kagent/mcp-servers/everything-test/mcpserver.yaml
```
Expected: one file, valid YAML, `kind: MCPServer`, no externalsecret.

- [ ] **Step 4: Scaffold `github-mcp-server` with dryRun=true**

Repeat with:
- name: `github-pr-bot`
- preset: `github-mcp-server`
- vaultPath: `kagent/mcp-servers/github-pr-bot`
- vaultTokenKey: `github-token`
- toolsets: `repos, pull_requests`
- dryRun: `true`

Expected:
```bash
ls /tmp/backstage-scaffolder/github-pr-bot/base-apps/kagent/mcp-servers/github-pr-bot/
# mcpserver.yaml
# externalsecret.yaml
```
Both YAML files valid.

- [ ] **Step 5: Scaffold a `custom` server with secrets, dryRun=true**

Repeat with the `custom-http-with-secret.json` fixture values. Confirm two files render and the ExternalSecret has both `data[]` entries.

### Task 8.2: Live production smoke test

**Files:**
- None

- [ ] **Step 1: Scaffold the smoke-test server live**

In the wizard, scaffold:
- name: `mcp-smoke-test-<YYYYMMDD>` (use today's date to make it unique)
- preset: `server-everything`
- dryRun: `false`

Capture the PR URL from the output.

- [ ] **Step 2: Review and merge the PR**

In the browser, open the PR URL. Verify the diff: one file added at `base-apps/kagent/mcp-servers/mcp-smoke-test-<date>/mcpserver.yaml`. Merge.

- [ ] **Step 3: Watch ArgoCD pick it up**

```bash
kubectl get application -n argocd kagent-secrets -o yaml | yq '.status.sync.status'
kubectl get mcpservers -n kagent
```
Expected: within ~3 min, the new MCPServer appears.

- [ ] **Step 4: Decommission the smoke test**

In the wizard, run the "Decommission Kagent MCP Server" template with the same name. Verify the teardown PR. Merge. Verify ArgoCD prunes within ~3 min.

### Task 8.3: Cleanup and final docs

**Files:**
- Delete: `docs/plans/kagent-mcp-server-lookups.md` (created in Task 0)

- [ ] **Step 1: Delete the lookups note**

The actual values are now in the template files; the temporary note is no longer needed.

Run: `rm docs/plans/kagent-mcp-server-lookups.md`

- [ ] **Step 2: Update top-level documentation (if any)**

Check whether there's a top-level template README:
```bash
ls examples/templates/README* 2>/dev/null
```
If yes, add a line about the new templates. If not, skip.

- [ ] **Step 3: Run the full contract test one more time**

Run: `bash scripts/kagent-mcp-server-template/test-contract.sh`
Expected: `All fixtures passed.`

Also re-run the agent contract test to confirm the renderer change didn't regress:
Run: `bash scripts/kagent-template/test-contract.sh`
Expected: `All fixtures passed.`

- [ ] **Step 4: Run all backend tests**

Run: `yarn workspace backend test`
Expected: all tests pass — including the two new test files (11 tests total across the two new files).

- [ ] **Step 5: Final commit**

```bash
git add -u
git commit -m "chore(kagent-mcp-server): remove temporary lookups note after fold-in"
```

- [ ] **Step 6: Open the PR**

Run:
```bash
gh pr create --title "feat(kagent): add MCP server scaffolder template + decommission" \
  --body "$(cat <<'EOF'
## Summary

Adds a Backstage scaffolder template (\`kagent-mcp-server\`) that provisions kmcp \`MCPServer\` CRDs into \`arigsela/kubernetes\` via PR + ArgoCD. Curated v1 catalog: \`server-everything\`, \`github-mcp-server\`, and a free-form \`custom\` path. Sibling \`kagent-mcp-server-decommission\` template tears down IDP-managed servers safely.

Companion spec: \`docs/superpowers/specs/2026-05-22-kagent-mcp-server-template-design.md\`

## Test plan

- [x] \`scripts/kagent-mcp-server-template/test-contract.sh\` passes for all 5 fixtures
- [x] Existing \`scripts/kagent-template/test-contract.sh\` still passes (renderer back-compat)
- [x] \`yarn workspace backend test\` passes (incl. 11 new tests across two action files)
- [x] Dry-run scaffold of all three presets writes correct files to \`/tmp/backstage-scaffolder/\`
- [x] Live scaffold of a smoke-test \`server-everything\` MCPServer; ArgoCD syncs and pod becomes Ready
- [x] Decommission template removes the smoke-test server cleanly

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Spec coverage check

Run through the spec section by section:

- **Architecture and file layout** → Phase 1, 3, 4, 5, 6, 7 ✓
- **Wizard pages and parameters** → Phase 5 (template.yaml) ✓
- **Curated catalog payloads** (server-everything, github, custom) → Phase 3.3 + Phase 4.2 ✓
- **Scaffolder steps pipeline** → Phase 5 ✓
- **Backend actions** → Phase 2 (validate-name) + Phase 6 (decommission) ✓
- **Why not generalize the agent actions?** → handled implicitly by separate copies, with rationale in code comments
- **Testing strategy** (offline rendering + backend tests + manual verification + CI) → Phase 3.2 + Phase 2.2 + Phase 6.2 + Phase 8 ✓
- **Open implementation questions** → Phase 0 (Task 0) ✓
- **Out of scope** → no tasks for these (intentional) ✓
