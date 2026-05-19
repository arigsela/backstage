# AIContext Catalog Modeling for kagent Agents — Design

**Status:** Draft
**Date:** 2026-05-19
**Owner:** group:platform-engineering
**Related:** RFC #33575 (Backstage upstream), `docs/plans/auto-discovery-contract-implementation-plan.md`

## Summary

Make kagent agents queryable as a first-class, structured concept in the
Backstage catalog so that future MCP-backed AI assistants can discover them and
call them. RFC #33575 (`kind: AIContext`) is not yet released; this design
delivers a **structurally equivalent** contract on top of the existing
`Component` entity using a dedicated `agents.platform.ai/*` annotation
namespace. Migration to upstream `AIContext` becomes a one-off ingestor
mapping when the RFC lands.

**Scope:** kagent template only. CrewAI is deferred to a follow-up spec.
**Primary consumer:** future MCP backend (not built here).

## Goals

- Expose every IDP-managed kagent Agent in the Backstage catalog with enough
  structured metadata for an MCP server to enumerate them, describe their
  capabilities, and route calls to their A2A endpoints — **using only the
  Backstage catalog API**, without a second K8s API hop.
- Stay on the existing single source of truth (the rendered Agent CRD in
  `arigsela/kubernetes`); no parallel catalog-info.yaml.
- Design annotation names that migrate cleanly to upstream `AIContext` fields
  when RFC #33575 lands.

## Non-goals

- Installing the MCP backend (`@backstage/plugin-mcp-actions-backend`). That
  is a separate effort that becomes feasible after we upgrade Backstage to
  v1.49.
- Modeling CrewAI agents. CrewAI has a different shape (multi-service Python
  app with an `/info` endpoint and the auto-discovery contract). A follow-up
  spec will adapt this contract to that shape.
- Adopting the literal `kind: AIContext`. RFC #33575 is unmerged.
- Backfilling existing agents in `arigsela/kubernetes`. The new annotations
  are inert until MCP exists; backfill can happen at MCP rollout time.

## Current state

- Kagent agents are scaffolded into `arigsela/kubernetes:base-apps/kagent/agents/<name>.yaml`.
- TeraSky's `kubernetes-ingestor` (`onlyIngestAnnotatedResources: true`) reads
  the rendered CRD's `terasky.backstage.io/add-to-catalog: "true"` and emits a
  `kind: Component` entity with `spec.type: kagent-agent`.
- The ingestor mirrors `metadata.annotations` 1:1 to the resulting entity's
  `metadata.annotations`. It does **not** mirror `spec.*`.
- Backstage is on v1.48.0. No MCP backend installed.

## Architecture

```
Scaffolder wizard
   │
   ▼
Renders Agent CRD (kagent.dev/v1alpha2) with:
   - existing terasky.backstage.io/* annotations
   - NEW agents.platform.ai/* annotations (the contract)
   │
   ▼
PR opens to arigsela/kubernetes
   │
   ▼
ArgoCD syncs Agent CRD → kagent namespace
   │
   ▼
TeraSky kubernetes-ingestor (runs every 30s) sees
the add-to-catalog annotation, creates/updates a
Component entity in the Backstage catalog. Copies
metadata.annotations 1:1 onto the entity.
   │
   ▼
Backstage catalog now holds:
   kind: Component
   spec.type: kagent-agent
   metadata.annotations:
     agents.platform.ai/version: "v1"
     agents.platform.ai/skills: <JSON>
     agents.platform.ai/delegates: <JSON>
     ...
   │
   ▼
(Future) MCP backend queries:
   GET /catalog/entities?filter=kind=Component,spec.type=kagent-agent
parses the annotations, exposes each agent as a
callable MCP tool.
```

**Why annotations, not labels or spec mirroring:**

- TeraSky mirrors `metadata.annotations` but not `spec.*`.
- K8s label values have a 63-char limit and character restrictions; JSON
  payloads don't fit.
- JSON-encoded annotation values are an established Backstage pattern
  (e.g. `backstage.io/source-location`).

**Why duplicate kagent CRD spec fields into annotations:**

The kagent CRD already carries the structured data in `spec.declarative.*`,
but Backstage entities only see what the ingestor mirrors. Without
duplication, MCP would need a second K8s API call per agent — making it
stateful about K8s and slower. Duplicating into annotations keeps MCP a pure
catalog-API client.

## The annotation contract (v1)

Namespace: `agents.platform.ai/*`. Added to `metadata.annotations` on the
rendered Agent CRD, alongside the existing terasky/backstage annotations.

| Annotation | Value | Source | Purpose |
| --- | --- | --- | --- |
| `agents.platform.ai/version` | `"v1"` | constant | Contract version for forward-compatibility |
| `agents.platform.ai/runtime` | `kagent` | constant | Discriminator (future: `crewai`) |
| `agents.platform.ai/description` | one-line, ≤200 chars | wizard `parameters.description` | Human-readable summary |
| `agents.platform.ai/a2a-endpoint` | `http://<name>.kagent.svc.cluster.local:8080` | derived from `parameters.name` | Where MCP routes calls |
| `agents.platform.ai/skills` | JSON array | wizard `parameters.skills` | A2A skills: `[{id,name,description,examples?,tags?}, …]` |
| `agents.platform.ai/delegates` | JSON array of strings | wizard `parameters.delegateAgents` | Peer agent names this agent can call |
| `agents.platform.ai/capabilities` | JSON object | constant per runtime | `{"streaming":true,"a2a":true}` for kagent |

### Empty-value conventions

- `skills`: `[]` (never null, never missing)
- `delegates`: `[]` (never null, never missing)
- All annotations are always present — MCP can rely on key existence rather
  than null-checking.

### Out of v1 (and why)

| Field | Rationale for deferral |
| --- | --- |
| `system-message-digest` | Would require a custom scaffolder action (Node `crypto`). Git already tracks systemMessage history; no current consumer needs the digest. |
| `disciplines` / `categories` | Adds wizard friction with no current consumer. Add in v2 if MCP later wants discipline-based routing. |
| Full `systemMessage` text | Too long for annotations; MCP can read from K8s on demand if it really needs the full text. |
| `lifecycle` | Handled by standard `spec.lifecycle` on the Component entity via TeraSky's own annotations. |
| Resource sizes (CPU/memory) | Runtime concern, not catalog concern. |

## Implementation surface

**Files touched: 1.**

### `examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml`

Add 7 new annotations under `metadata.annotations` (existing annotations
unchanged):

```yaml
metadata:
  annotations:
    # --- existing ---
    terasky.backstage.io/add-to-catalog: "true"
    terasky.backstage.io/component-type: kagent-agent
    backstage.io/managed-by-location: url:https://github.com/arigsela/kubernetes/blob/main/base-apps/kagent/agents/${{ values.name }}.yaml
    backstage.io/owner: ${{ values.owner }}
    # --- NEW: agent contract v1 ---
    agents.platform.ai/version: "v1"
    agents.platform.ai/runtime: kagent
    agents.platform.ai/description: ${{ values.description | trim }}
    agents.platform.ai/a2a-endpoint: http://${{ values.name }}.kagent.svc.cluster.local:8080
    agents.platform.ai/skills: |-
      ${{ values.skills | dump }}
    agents.platform.ai/delegates: |-
      ${{ values.delegateAgents | dump }}
    agents.platform.ai/capabilities: '{"streaming":true,"a2a":true}'
```

**Nunjucks/YAML notes:**

- `| dump` produces a JSON string from the input value
- `|-` block scalar forces YAML to treat the JSON output as a string, not
  parse it as nested YAML
- Empty arrays render as `[]`
- No new dependencies, no custom scaffolder actions

### `examples/templates/kagent-agent/template.yaml`

**No changes.** All needed data is already collected by the existing wizard
(`parameters.description`, `parameters.skills`, `parameters.delegateAgents`,
`parameters.name`).

## Testing strategy

### Layer 1 — Render correctness (no cluster)

Use the existing `dryRun` wizard toggle. Output goes to
`/tmp/backstage-scaffolder/<name>/base-apps/kagent/agents/<name>.yaml`.

Manual checks (codify in `scripts/` once stable):

- File is valid YAML (`yq eval`)
- All 7 `agents.platform.ai/*` annotations present
- `skills`, `delegates`, `capabilities` values parse as JSON
- `a2a-endpoint` matches `http://<name>.kagent.svc.cluster.local:8080`

Fixture wizard inputs:

- Empty `skills`, empty `delegateAgents` → expect `[]` (not `null`)
- One skill with `examples` + `tags` → round-trips
- Two delegate agents → JSON array of strings
- Description with special chars (`"`, `'`, one line, ≤200 chars)

### Layer 2 — Ingestion correctness (cluster required)

Scaffold a real agent end-to-end. ~30s after ArgoCD sync:

```bash
curl -s "$BACKSTAGE_URL/api/catalog/entities/by-name/component/default/<name>" \
  | jq '.metadata.annotations | with_entries(select(.key | startswith("agents.platform.ai/")))'
```

Assertions:

- All 7 annotations made it through TeraSky's ingestor unchanged
- JSON values still parse after the K8s → ingestor → catalog round-trip
- `spec.type == "kagent-agent"` (regression check)

### Layer 3 — Contract validity script

A ~30-line script (TS or Python) that:

1. Queries `/api/catalog/entities?filter=kind=Component,spec.type=kagent-agent`
2. Parses the 4 JSON-valued annotations per agent
3. Schema-validates against the v1 contract

This is the canary for breakage on Backstage or TeraSky upgrades, and the
seed of the future MCP server's catalog reader.

### Out of scope for testing

- Actual MCP behavior (no server installed)
- kagent runtime behavior at `a2a-endpoint` (kagent's responsibility)
- AIContext migration (untestable until RFC #33575 ships)

## Error handling

| Failure mode | Mitigation |
| --- | --- |
| User submits invalid skill structure | Wizard parameter schema already covers shape; can add `pattern` on skill `id` for tighter validation |
| JSON breaks YAML parsing at ArgoCD apply | Layer 1 dry-run catches in PR; `|-` block scalar protects |
| TeraSky strips unknown annotations | If observed at Layer 2, fall back to `terasky.backstage.io/`-prefixed annotation names (TeraSky reliably mirrors its own prefix) |
| Skills/delegates contain unsafe chars | `dump` escapes per JSON spec; YAML string scalar shields from interpretation |
| Duplicate agent name | Existing `kagent:agent:validate-name` action handles this |

## Rollout

- **No feature flag.** New annotations are inert until something reads them.
- **No backfill required.** Existing rendered CRDs keep working; they just
  lack the new annotations until re-rendered. MCP (when installed) should
  treat missing annotations as "legacy agent, skip" rather than failing.
- **Rollback:** revert the single template file. Already-merged agent PRs are
  unaffected (annotations are harmless metadata).

## AIContext migration (when RFC #33575 ships)

Two-phase migration:

1. **Phase A — Emit `kind: AIContext` entities.** Requires either (a) TeraSky
   to gain custom-kind support, or (b) a sidecar `catalog-info.yaml` step in
   the scaffolder. Choice depends on what's available at the time.
2. **Phase B — Translate existing v1 annotations.** One-off script reads
   `/api/catalog/entities?filter=kind=Component,spec.type=kagent-agent`, maps
   each annotation to its AIContext field, writes a migration PR updating the
   CRDs in place.

### Field mapping (annotation → AIContext)

| v1 annotation | AIContext field |
| --- | --- |
| `agents.platform.ai/skills` | `spec.skills` |
| `agents.platform.ai/delegates` | `spec.agents` (peer refs) |
| `agents.platform.ai/capabilities` | `spec.allowedTools` (inverse: what this agent uses) |
| `agents.platform.ai/runtime` | `spec.categories[]` |
| `agents.platform.ai/description` | `metadata.description` |

`agents.platform.ai/version` and `agents.platform.ai/a2a-endpoint` have no
direct AIContext equivalent and remain as Backstage annotations on the
migrated `AIContext` entity (`version` becomes legacy metadata; `a2a-endpoint`
stays useful for MCP routing regardless of kind).

No data loss path — the v1 annotations preserve every field AIContext needs.

## Documentation updates as part of this work

- Inline comments in `${{ values.name }}.yaml` explaining each new annotation
- New section in `docs/guides/` documenting the `agents.platform.ai/*`
  contract for future consumers (MCP authors, scorecard authors)
- Cross-reference from `docs/plans/auto-discovery-contract-implementation-plan.md`

## Open questions

None blocking. Items for future specs:

- CrewAI adaptation of this contract (separate spec)
- Whether the v2 contract should add `system-message-digest` once MCP exists
- Whether `disciplines` belongs in v2 or in `spec.tags` on the Component
