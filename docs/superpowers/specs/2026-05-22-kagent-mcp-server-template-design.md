# Kagent MCP Server Scaffolder Template — Design

**Date:** 2026-05-22
**Status:** Approved (brainstorming complete; awaiting implementation plan)
**Companion templates:** `kagent-agent`, `kagent-agent-decommission` (existing patterns)

---

## Summary

Add a Backstage scaffolder template that provisions a kmcp `MCPServer` CRD
(API: `kagent.dev/v1alpha1`, the Pod-deploying kind) into the GitOps repo
`arigsela/kubernetes`. The template ships with a curated dropdown of two
common MCP servers (`server-everything`, `github-mcp-server`) plus a
free-form "custom" path. When the chosen server needs secrets, the template
also renders a sibling `ExternalSecret` so credentials flow from Vault via
External Secrets Operator. A second template handles decommission.

Out of scope for v1: `RemoteMCPServer` registration, OBO/STS configuration,
externalized catalog files, generalization of the agent-side scaffolder
actions.

## Motivation

The `kagent-agent` template handles Agent CRDs but agents need tools, and
tools come from MCP servers. Today, deploying a new MCP server in the
cluster requires hand-editing YAML in `arigsela/kubernetes`. A self-service
template:

- Closes the loop on the kagent IDP story (agents + their tools both
  scaffoldable from Backstage)
- Standardizes labels and namespace placement so the IDP-managed kagent
  resources are discoverable and safely deletable
- Encodes the "secrets come from Vault via ExternalSecret" convention so
  no PAT or API key is ever pasted into a wizard or committed to GitOps

## Background

Three MCP-related CRDs exist in kagent (`docs/reference/kagent/docs/architecture/crds-and-types.md`):

| CRD | API group | Behavior | Relevant to v1? |
|---|---|---|---|
| `MCPServer` | `kagent.dev/v1alpha1` (kmcp) | Deploys an MCP server as a Pod. Stdio commands are wrapped in an `agentgateway` sidecar that exposes HTTP. | **Yes** |
| `RemoteMCPServer` | `kagent.dev/v1alpha2` | Registers an externally-hosted MCP server by URL. No Pod deployed. | No |
| `ToolServer` | `kagent.dev/v1alpha1` (legacy) | Deprecated by EP-685. | No |

OBO / STS token propagation (`docs/reference/kagent/go/adk/pkg/sts/`) works
with both `MCPServer` and `RemoteMCPServer` because both terminate in
HTTP transports kagent can inject headers into. The MCP server's own auth
model determines whether OBO is useful — `github-mcp-server` uses a static
PAT, not OBO. OBO config lives on the Agent CRD, not on the MCPServer, so
it is not surfaced in this template.

## Architecture and file layout

### New scaffolder templates (in this repo)

```
examples/templates/kagent-mcp-server/
├── template.yaml
└── content/
    ├── base/                                # always rendered
    │   └── base-apps/kagent/mcp-servers/${{ values.name }}/
    │       └── mcpserver.yaml
    └── with-secret/                         # rendered only when secret needed
        └── base-apps/kagent/mcp-servers/${{ values.name }}/
            └── externalsecret.yaml

examples/templates/kagent-mcp-server-decommission/
└── template.yaml
```

Splitting `content/` into `base/` and `with-secret/` lets a step-level `if:`
guard the optional secret file without rendering an empty placeholder.

### New backend scaffolder actions

```
packages/backend/src/modules/scaffolder/
├── kagentMcpServerValidateNameAction.ts     # id: kagent:mcp-server:validate-name
├── kagentMcpServerValidateNameAction.test.ts
├── kagentMcpServerDecommissionAction.ts     # id: kagent:mcp-server:open-decommission-pr
└── kagentMcpServerDecommissionAction.test.ts
```

Registered in `packages/backend/src/modules/scaffolder/index.ts` alongside
the existing exports.

### Output in `arigsela/kubernetes`

```
base-apps/kagent/mcp-servers/<name>/
├── mcpserver.yaml
└── externalsecret.yaml     # present only when secrets are configured
```

ArgoCD's existing `kagent-secrets` app already syncs `base-apps/kagent/`
recursively. No app-of-apps change required.

## Wizard pages and parameters

Five pages. Pages 3a/3b/3c are mutually exclusive — only the one matching
the `preset` choice is shown. Implemented with JSON Schema `dependencies` +
`oneOf` (the standard Backstage scaffolder conditional-display mechanism).

### Page 1 — Identity (always shown)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | ✅ | Pattern `^[a-z][a-z0-9-]{2,38}[a-z0-9]$`. Folder name and CRD `metadata.name`. |
| `description` | string | ✅ | One sentence; surfaces in PR body. |
| `owner` | string | ✅ | EntityPicker filtered to `[Group, User]`. |

### Page 2 — Preset (always shown)

| Field | Type | Notes |
|---|---|---|
| `preset` | enum | `server-everything` \| `github-mcp-server` \| `custom`. Renders as `ui:widget: radio` so trade-offs are visible. |

### Page 3a — server-everything config

No fields. All defaults baked into the rendered manifest.

### Page 3b — github-mcp-server config

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `vaultPath` | string | ✅ | `kagent/mcp-servers/<name>` | Used as ExternalSecret `data[].remoteRef.key`. |
| `vaultTokenKey` | string | ✅ | `github-token` | Vault property holding the PAT. |
| `githubToolsets` | string[] | optional | `[]` | Empty = all toolsets. Joined comma-separated into `GITHUB_TOOLSETS` env. |

### Page 3c — Custom MCP server

| Field | Type | Required | Notes |
|---|---|---|---|
| `image` | string | optional | Empty + `cmd: npx` → kmcp uses its default node image (verified in `everything-mcp-server.yaml` e2e fixture). For non-npx cmds, the implementation plan will require `image`. |
| `cmd` | string | ✅ | Executable. |
| `args` | string[] | optional | Argv after `cmd`. |
| `transportType` | enum | ✅ | `stdio` \| `streamable_http` \| `sse`. Default `stdio`. |
| `port` | integer | conditional | Required when `transportType != stdio`. |
| `extraEnv` | `{name, value}[]` | optional | Plain literal env vars. |
| `vaultSecrets` | `{envName, vaultPath, vaultKey}[]` | optional | Non-empty → ExternalSecret rendered. |

### Page 4 — Resources (always shown, all defaulted)

| Field | Default |
|---|---|
| `cpuRequest` | `100m` |
| `cpuLimit` | `500m` |
| `memoryRequest` | `128Mi` |
| `memoryLimit` | `512Mi` |

### Page 5 — Publish

| Field | Type | Notes |
|---|---|---|
| `dryRun` | boolean | When true, writes to `/tmp/backstage-scaffolder/<name>/`. |

## Curated catalog payloads

### `preset: server-everything` → `mcpserver.yaml` only

```yaml
apiVersion: kagent.dev/v1alpha1
kind: MCPServer
metadata:
  name: <name>
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
    app.kubernetes.io/managed-by: kagent
    app.kubernetes.io/name: <name>
    arigsela.com/idp-managed: "true"
    backstage.io/owner: <owner>
spec:
  transportType: stdio
  deployment:
    cmd: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-everything@latest"
    resources:
      requests: { cpu: <cpuRequest>, memory: <memoryRequest> }
      limits:   { cpu: <cpuLimit>,   memory: <memoryLimit> }
```

### `preset: github-mcp-server` → `mcpserver.yaml` + `externalsecret.yaml`

```yaml
# mcpserver.yaml
apiVersion: kagent.dev/v1alpha1
kind: MCPServer
metadata:
  name: <name>
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
    app.kubernetes.io/managed-by: kagent
    app.kubernetes.io/name: <name>
    arigsela.com/idp-managed: "true"
    backstage.io/owner: <owner>
spec:
  transportType: streamable_http
  deployment:
    port: 8080
    image: ghcr.io/github/github-mcp-server:latest
    # cmd / args resolved during implementation by inspecting the image's
    # ENTRYPOINT at the pinned tag — see "Open implementation questions".
    env:
      - name: GITHUB_PERSONAL_ACCESS_TOKEN
        valueFrom:
          secretKeyRef:
            name: <name>-github-token
            key: github-token
      # GITHUB_TOOLSETS only emitted when the wizard list is non-empty
      - name: GITHUB_TOOLSETS
        value: "<comma-joined toolsets>"
    resources:
      requests: { cpu: <cpuRequest>, memory: <memoryRequest> }
      limits:   { cpu: <cpuLimit>,   memory: <memoryLimit> }
```

```yaml
# externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: <name>-github-token
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
    app.kubernetes.io/name: <name>
    arigsela.com/idp-managed: "true"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend     # ClusterSecretStore name — verify in implementation
    kind: ClusterSecretStore
  target:
    name: <name>-github-token
    creationPolicy: Owner
  data:
    - secretKey: github-token
      remoteRef:
        key: <vaultPath>
        property: <vaultTokenKey>
```

### `preset: custom` → `mcpserver.yaml` + optional `externalsecret.yaml`

`mcpserver.yaml` is the same shape as the other presets, but every
deployment field is conditional on the wizard input being non-empty.
`env:` entries come from `extraEnv` (literal) followed by `vaultSecrets`
(secretKeyRef into a single Secret named `<name>-secrets`).

`externalsecret.yaml` is rendered only when `vaultSecrets | length > 0`:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: <name>-secrets
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
    app.kubernetes.io/name: <name>
    arigsela.com/idp-managed: "true"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: <name>-secrets
    creationPolicy: Owner
  data:
    # one entry per vaultSecrets item
    - secretKey: <envName lowercased>
      remoteRef:
        key: <vaultPath>
        property: <vaultKey>
```

The `secretKey` is the lowercased `envName` so the MCPServer's
`secretKeyRef.key` lookup is deterministic.

## Scaffolder steps pipeline

```yaml
steps:
  - id: validate-name
    name: Verify MCP server name is available
    action: kagent:mcp-server:validate-name
    input:
      name: ${{ parameters.name | trim }}

  - id: fetch-base
    name: Render MCPServer manifest
    action: fetch:template
    input:
      url: ./content/base
      values:
        name:           ${{ parameters.name | trim }}
        description:    ${{ parameters.description | trim }}
        owner:          ${{ parameters.owner | trim }}
        preset:         ${{ parameters.preset }}
        githubToolsets: ${{ parameters.githubToolsets }}
        image:          ${{ parameters.image }}
        cmd:            ${{ parameters.cmd }}
        args:           ${{ parameters.args }}
        transportType:  ${{ parameters.transportType }}
        port:           ${{ parameters.port }}
        extraEnv:       ${{ parameters.extraEnv }}
        vaultSecrets:   ${{ parameters.vaultSecrets }}
        cpuRequest:     ${{ parameters.cpuRequest | trim }}
        cpuLimit:       ${{ parameters.cpuLimit | trim }}
        memoryRequest:  ${{ parameters.memoryRequest | trim }}
        memoryLimit:    ${{ parameters.memoryLimit | trim }}

  - id: fetch-secret
    name: Render ExternalSecret manifest
    if: >-
      ${{ parameters.preset == "github-mcp-server"
          or (parameters.preset == "custom" and (parameters.vaultSecrets | length) > 0) }}
    action: fetch:template
    input:
      url: ./content/with-secret
      values:
        name:          ${{ parameters.name | trim }}
        preset:        ${{ parameters.preset }}
        vaultPath:     ${{ parameters.vaultPath }}
        vaultTokenKey: ${{ parameters.vaultTokenKey }}
        vaultSecrets:  ${{ parameters.vaultSecrets }}

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

Notes:

- `useExternalSecret` is computed inline in the step `if:` — no extra
  action needed.
- Both `fetch:template` steps land files in the same workspace folder; the
  PR contains all rendered files in a single commit.
- Validation runs before rendering so duplicate names fail in <1s.

## Backend actions

### `kagent:mcp-server:validate-name`

Copy of `kagentValidateNameAction.ts` (98 lines) with one substantive
change: scans `base-apps/kagent/mcp-servers/<name>/` (folder) and the
legacy file form `base-apps/kagent/mcp-servers/<name>.yaml`. Treats either
as a name collision.

### `kagent:mcp-server:open-decommission-pr`

Adapts `kagentDecommissionAction.ts` (278 lines). Differences:

- **Deletes a folder.** `getContent` on the folder path lists entries, then
  `deleteFile` runs for each entry. The agent action only ever deletes one
  file; this is the one real behavior change.
- **IDP-management guard.** Reads each YAML before deleting and refuses if
  `arigsela.com/idp-managed: "true"` label is absent. Matches the regex check
  in `kagentDecommissionAction.ts`.
- **Best-effort consumer warning.** Greps agent manifests in the repo for
  `tools[].mcpServer.name == <name>`. If any are found, the PR body lists
  them as a "still-referenced" warning without blocking.
- **PR metadata.** Branch `scaffolder/remove-mcp-server-<name>`, title
  `chore(kagent): decommission <name> MCP server`.

Estimated size: 250–300 lines.

### Why not generalize the agent actions?

Considered making `kagent:agent:validate-name` into `kagent:validate-name`
with a `kind` input. Not doing it because:

- Two callers ≠ rule of three.
- The decommission action's deletion logic genuinely differs (one file vs
  folder + label checks on multiple files).
- Easy to revisit when a third kagent kind appears.

## Testing strategy

### Offline rendering tests (primary coverage)

Reuses `scripts/kagent-template/render.js` and the `test-contract.sh`
pattern. Two minor changes:

1. Generalize `render.js` to accept the template path as a CLI arg
   (currently hard-coded to the agent template path).
2. Add `scripts/kagent-mcp-server-template/` with fixtures + golden files
   + a sibling `test-contract.sh`.

Fixtures (each maps to a golden output directory):

| Fixture | Renders |
|---|---|
| `server-everything.json` | `mcpserver.yaml` only |
| `github-mcp-server.json` | `mcpserver.yaml` + `externalsecret.yaml` |
| `custom-stdio.json` | `mcpserver.yaml` only (no secrets, no port) |
| `custom-http-with-secret.json` | `mcpserver.yaml` + `externalsecret.yaml` |
| `custom-extraenv-only.json` | `mcpserver.yaml` only, plain env vars |

Coverage targets:

- Correct file combination per preset
- Custom preset's conditional blocks produce clean YAML (no stray blank
  lines, no empty `env: []`)
- `vaultSecrets[].envName` lowercase transformation works for `secretKey`
- Resource defaults flow through unchanged
- `githubToolsets` array joins to comma-separated string

### Backend action unit tests

Mirror existing `*Action.test.ts` patterns (Jest + mocked Octokit).

`kagentMcpServerValidateNameAction.test.ts`:
- name available → passes
- folder collides → throws
- legacy file collides → throws
- missing `GITHUB_TOKEN` → throws
- 5xx error propagates

`kagentMcpServerDecommissionAction.test.ts`:
- happy-path folder delete
- missing-folder rejects
- IDP-label missing on any file → rejects whole operation
- partial-delete recovery
- dry-run path

### Manual verification (documented in implementation plan)

1. `yarn dev`, scaffold each preset with `dryRun: true`, eyeball
   `/tmp/backstage-scaffolder/<name>/`.
2. Scaffold `server-everything` with `dryRun: false`, watch ArgoCD pick up
   the PR after merge, confirm `kubectl get mcpservers -n kagent` shows it
   Ready.
3. Reference the new MCPServer from an existing agent's `tools[].mcpServer`
   and confirm tool discovery works.
4. Decommission via the sibling template, watch ArgoCD prune.

### CI integration

Add the new `test-contract.sh` to whatever pipeline currently runs the
agent contract test. Implementation plan will surface the current CI state
of the agent test as a sub-task and wire both consistently.

## Open implementation questions

These are not blockers for the spec — they are factual lookups the
implementation plan will resolve before writing the manifests.

1. **`github-mcp-server` cmd / args.** The upstream image's HTTP entrypoint
   isn't pinned here. Resolve by inspecting the `ENTRYPOINT` of
   `ghcr.io/github/github-mcp-server:latest` at the chosen tag.
2. **`ClusterSecretStore` name.** Spec assumes `vault-backend` based on
   memory of the Backstage namespace. Verify in cluster (could be `vault`
   or another name) before merging the implementation.

## Out of scope (v1)

- **`RemoteMCPServer` template.** Different CRD shape, different use case
  (registering already-running external servers). Add later if needed.
- **OBO/STS surfacing.** STS is configured on the Agent CRD, not on the
  MCPServer. Plus none of the curated v1 servers use OBO. Revisit when an
  in-house OIDC-validating MCP server is in scope.
- **Externalized curated catalog.** Catalog entries live in the template
  body for v1. Revisit when the catalog has churned a few times.
- **Generalizing the agent-side scaffolder actions** into kind-parametric
  forms. Revisit on the third kagent kind.
- **Surfacing the new template's link on agent entity pages.** The
  `kagent-chat-link` work (separate spec) is the precedent if this becomes
  worthwhile.

## References

- Existing scaffolder pair: `examples/templates/kagent-agent/`,
  `examples/templates/kagent-agent-decommission/`
- Existing backend actions:
  `packages/backend/src/modules/scaffolder/kagentValidateNameAction.ts`,
  `packages/backend/src/modules/scaffolder/kagentDecommissionAction.ts`
- Offline rendering harness: `scripts/kagent-template/`
- Kagent architecture reference:
  `docs/reference/kagent/docs/architecture/crds-and-types.md`
- kmcp MCPServer examples:
  `docs/reference/kagent/contrib/tools/mcpserver-custom-registry-example.yaml`,
  `docs/reference/kagent/go/core/test/e2e/manifests/everything-mcp-server.yaml`
- EP-685 (kmcp first-class support):
  `docs/reference/kagent/design/EP-685-kmcp.md`
- Companion: `2026-05-18-kagent-idp-design.md` (the broader kagent IDP
  story this template extends)
