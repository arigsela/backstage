# Kagent Chat Link on Backstage Agent Entity — Design

**Date:** 2026-05-22
**Status:** Approved
**Author:** Ari Sela (via Claude Code brainstorming)

## Problem

A scaffolded kagent agent appears in Backstage's catalog as a Component entity (e.g.
`/catalog/default/component/homelab-knowledge`). The entity page renders a Links card,
but for kagent agents that card currently says "No links defined for this entity."

Each agent has a live chat dashboard at
`https://kagent.arigsela.com/agents/kagent/<agent-name>/chat`. There is no affordance
on the Backstage entity page that takes the viewer there — they have to know the
URL pattern and type it by hand.

## Goal

Newly scaffolded kagent agents should display a "Chat with this agent" link in the
Backstage entity page's Links card, deep-linking to the kagent chat dashboard for
that specific agent.

## Non-Goals

- Retrofitting the ~7 existing agents in `arigsela/kubernetes` (`homelab-knowledge`,
  `k8s-agent`, `helm-agent`, `istio-agent`, `kgateway-agent`,
  `argo-rollouts-conversion-agent`, `observability-agent`). They keep showing
  "No links defined" until manually edited.
- Adding any other links (agent overview page, GitHub source, etc.).
- Making the kagent base URL configurable per environment.

## Mechanism

The TeraSky `kubernetes-ingestor` already supports a `terasky.backstage.io/links`
annotation. Implementation reference:
`node_modules/@terasky/backstage-plugin-kubernetes-ingestor/dist/providers/EntityProvider.cjs.js:3248`.

The ingestor:

1. Reads the annotation value as a string.
2. `JSON.parse`s it — expects an array of `{ url, title, icon, type }` objects.
3. Emits each entry as `metadata.links[]` on the Backstage catalog entity.

So no plugin code is needed — just inject the annotation in the rendered Agent CRD.

## Change

One annotation added to the rendered template at
`examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml`,
in the existing `annotations:` block alongside the other `terasky.backstage.io/*`
annotations:

```yaml
terasky.backstage.io/links: '[{"url":"https://kagent.arigsela.com/agents/kagent/${{ values.name }}/chat","title":"Chat with this agent","icon":"chat"}]'
```

### Why this specific shape

- **Single-quoted YAML scalar.** No backslash escaping. The only YAML escape required
  inside a single-quoted scalar is doubling embedded single quotes — none of which
  appear in this value.
- **Compact JSON on one line.** The ingestor calls `JSON.parse` on the string; both
  pretty-printed and compact JSON are equivalent. Compact keeps the diff readable
  in PRs to the kubernetes repo.
- **Nunjucks substitutes `${{ values.name }}` at scaffold time.** The YAML committed
  to the repo contains the literal agent name in the URL — the ingestor never sees
  Nunjucks syntax.
- **Icon `chat`.** Member of Backstage's default registered icon set, so it renders
  without additional frontend configuration.

### Safety: JSON injection

Agent names are validated by the existing wizard regex
`^[a-z][a-z0-9-]{2,38}[a-z0-9]$` (lowercase letters, digits, hyphens only). None of
those characters require JSON escaping, so substituting `${{ values.name }}` into
the JSON-encoded annotation cannot produce malformed JSON.

## End-to-End Flow

1. User scaffolds a new agent via the Kagent Declarative Agent template.
2. Scaffolder renders the CRD YAML with the literal annotation baked in and opens
   a PR against `arigsela/kubernetes`.
3. PR merges → ArgoCD's `kagent-secrets` app applies the Agent CRD.
4. TeraSky `kubernetes-ingestor` re-scans on its 30s cadence
   (`kubernetesIngestor.components.taskRunner.frequency: 30` in `app-config.yaml`),
   reads the annotation, parses it, emits `metadata.links` on the catalog entity.
5. The agent's entity page Links card renders "Chat with this agent" linking to
   `https://kagent.arigsela.com/agents/kagent/<name>/chat`.

## Testing

Use the template's existing dry-run mode (`dryRun: true` on the Publish page).
Output is written to `/tmp/backstage-scaffolder/<name>/`; inspecting the rendered
`base-apps/kagent/agents/<name>.yaml` should show the annotation with the substituted
name. Full end-to-end verification requires a real run, merging the kubernetes PR,
and waiting one ingestor cycle (≤ 30s).

## Risks / Open Issues

- **Ingestor strips unknown annotations** (documented mitigation in the agent
  annotation contract). The `terasky.backstage.io/*` prefix is the ingestor's own
  namespace and is reliably mirrored, so this annotation is not at risk.
- **Existing agents not retrofitted.** Intentional per scope decision. Side effect:
  inconsistent UX between agents created before and after this change until the
  existing seven are manually updated.
