# Kagent IDP overview

What kagent is in this homelab, which agents exist, and where to interact with them.

## What kagent is

[kagent](https://kagent.dev) is a Kubernetes-native runtime for declarative AI agents. Each agent is a `kagent.dev/v1alpha2 Agent` CRD: the controller spawns a Deployment per agent, the agent process loads its prompt + tool config, and serves an [A2A protocol](https://github.com/google/A2A) endpoint that other agents and clients can call.

In this homelab kagent gives us in-cluster agents that:

- **Delegate to specialists** (e.g. an orchestrator agent routes a "list Helm releases" question to `helm-agent`)
- **Read live cluster state** via MCP-backed tools (e.g. `k8s-agent` calls `kagent-tool-server` to list pods)
- **Remember context** via vector-backed long-term memory (pgvector + per-user embeddings)

See [kagent.dev/docs](https://kagent.dev/docs/kagent) for the upstream concept docs.

## Agents in this cluster

### Chart-installed (kagent Helm 0.8.6)

These come from the upstream chart with default config — they expose MCP tools backed by `kagent-tool-server`:

| Agent | Purpose |
|---|---|
| `k8s-agent` | Kubernetes cluster operations (pods, deployments, RBAC, troubleshooting) |
| `helm-agent` | Helm release lifecycle (install/upgrade/rollback, chart inspection) |
| `istio-agent` | Istio service mesh configuration and traffic management |
| `kgateway-agent` | Kubernetes Gateway API (kgateway / Envoy) |
| `observability-agent` | Prometheus + Grafana metrics and dashboards |
| `argo-rollouts-conversion-agent` | Convert Deployments to Argo Rollouts for progressive delivery |

!!! warning "observability-agent is currently broken"
    Its `tools[]` references `promql-agent` which is disabled in our Helm values. Status shows `Accepted=False (ReconcileFailed)`. Don't add it as a delegate to new agents until the chart-level fix lands. See the [operator gotchas](managing-agents.md#operator-gotchas) for details.

### Custom orchestrators (in `base-apps/kagent/`)

These are hand-authored Agent CRDs in this GitOps repo — they don't run their own tools, they delegate to the chart agents:

| Agent | Purpose | How it was created |
|---|---|---|
| `build-orchestrator` | Cross-domain orchestrator (delegates across all specialists) | Hand-crafted YAML |
| `homelab-knowledge` | Q&A about the GitOps repo + live cluster state | Backstage IDP wizard (v1.6) |

`homelab-knowledge` is the first IDP-created agent. New custom orchestrators land in `base-apps/kagent/agents/` via the Backstage wizard — see [Creating an agent](creating-agents.md).

## Where to access agents

Three entry points, each suited to different use:

### kagent UI — chat in your browser

<https://kagent.arigsela.com> — pick an agent from the sidebar and chat. The UI manages the conversation `contextId` automatically, so memory works across messages in the same chat. Each browser tab is one session.

### Backstage catalog — entity view

<https://backstage.arigsela.com/catalog?filters[kind]=component> — filter by `Type: kagent-agent`. Each agent has a 3-tab entity page:

- **Overview** — standard entity card + "About this agent" card (rendered live from the Agent CRD's `spec.declarative.*` fields)
- **Kubernetes** — the spawned Pod / Deployment / Service / ReplicaSet / ServiceAccount, plus the Agent CRD itself in the Custom Resources panel
- **Docs** — TechDocs (currently empty for kagent agents — these docs you're reading are the section-level IDP playbook, not per-agent docs)

### A2A endpoint — programmatic, in-cluster only

```bash
POST http://<agent-name>.kagent.svc.cluster.local:8080/
```

JSON-RPC 0.3.0 protocol. Useful when you want to script an agent call from another in-cluster service. Full curl example in [Managing & decommissioning](managing-agents.md#chatting-with-an-agent).

## How agents work — quick mental model

An agent has four moving parts:

1. **System message** — the prompt that shapes its behavior. Can use `{{include "builtin/..."}}` directives to pull in shared snippets (safety guardrails, k8s context, tool-usage best practices) from the `kagent-builtin-prompts` ConfigMap.
2. **Tools list** — either delegated agents (`tools[].type: Agent`) OR MCP servers (`tools[].type: McpServer`). Our IDP-created orchestrators use the first; the chart agents use the second.
3. **Memory** (optional) — embedding-model-backed long-term memory stored in pgvector. Auto-extracts info every 5 user messages; auto-retrieves before each response. Scoped per user (derived from the request `contextId`).
4. **Deployment resources** — CPU/memory requests + limits for the spawned pod.

On each user message the agent runs: read message → optionally call `prefetch_memory` → optionally call tools (delegate or MCP) → synthesize response → optionally call `save_memory` → return.

## Next steps

- **[Create a new agent](creating-agents.md)** via the Backstage wizard
- **[View, manage, decommission](managing-agents.md)** existing agents
