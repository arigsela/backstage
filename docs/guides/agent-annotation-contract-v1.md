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
- **Live catalog (Layer 3):** `BACKSTAGE_URL=https://backstage.arigsela.com BACKSTAGE_TOKEN=<optional> bash scripts/check-agent-contract.sh` *(Layer 2 — live ingestion correctness — is operator-driven and not automatable; see the design spec.)*

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
