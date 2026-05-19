# Creating a kagent agent

End-to-end walkthrough of the Backstage **Kagent Declarative Agent** template.

## Quick path

1. Open <https://backstage.arigsela.com/create>
2. Click **Kagent Declarative Agent → Choose**
3. Walk the 5-page wizard (Identity / Behavior / A2A Skills / Resources / Publish)
4. Click **Review → Create**
5. Open the PR that gets created in `arigsela/kubernetes`, review the rendered Agent CRD, merge
6. ArgoCD syncs within ~3 min → kagent controller spawns the pod → Backstage catalog auto-ingests the entity within ~2 min more

## Wizard pages — what to put where

### Page 1: Identity

| Field | Notes |
|---|---|
| **Agent name** | Lowercase + hyphens, 4-40 chars. Becomes both the K8s resource name and the file path (`base-apps/kagent/agents/<name>.yaml`). Example: `release-coordinator` |
| **Description** | One sentence shown in the catalog and on the entity card. Keep it functional ("Coordinates release activities across helm, argo-rollouts, and k8s domains"), not aspirational |
| **Owner** | Pick from the Group/User picker. Typically `group:default/platform-engineering` |

### Page 2: Behavior

| Field | Notes |
|---|---|
| **System message** | The prompt — see [Writing good system messages](#writing-good-system-messages) below |
| **Include builtin prompts** | **Leave ON** unless you have a reason. Lets your system message use `{{include "builtin/safety-guardrails"}}` and `{{include "builtin/kubernetes-context"}}` directives that pull in the chart's standard snippets |
| **Delegate agents** | At least one required. Pick from the 6 chart-installed agents. **Skip `observability-agent` for now** — it's broken (see [operator gotchas](managing-agents.md#operator-gotchas)) |

### Page 3: A2A Skills (optional)

For each skill: `id` (kebab-case), `name` (display), `description` (one sentence), `examples` (3-5 strings), `tags` (comma-separated). Empty list is fine — skills are A2A protocol metadata for capability discovery, not required for the agent to run.

The skills you define here show up at the agent's A2A endpoint (`/.well-known/agent.json`) and in the "About this agent" Backstage card.

### Page 4: Resources (optional, defaults are fine)

| Field | Default |
|---|---|
| CPU request / limit | `100m` / `1000m` |
| Memory request / limit | `256Mi` / `1Gi` |
| Compaction interval | `5` (turns between context compaction) |
| Overlap size | `2` (turns kept verbatim across compactions) |

Bump CPU/memory only if you observe OOM or throttling. Compaction interval rarely needs tuning.

### Page 5: Publish

| Field | Notes |
|---|---|
| **Dry run** | **Turn ON for your first attempt with a new system message.** Writes the rendered YAML to `/tmp/backstage-scaffolder/<name>/` inside the Backstage pod instead of opening a PR. Inspect with `kubectl exec` to verify the rendered output looks right, then re-run with dry-run OFF for the real PR |

## What gets created in the cluster

After ArgoCD syncs your merged PR, kagent's controller creates 5 resources per agent:

```bash
kubectl get all,sa -n kagent -l app.kubernetes.io/name=<name>
```

- `agent.kagent.dev/<name>` — the source CRD (from your YAML)
- `deployment.apps/<name>` — controller-spawned, runs the Python ADK image
- `replicaset.apps/<name>-<hash>` — owned by the Deployment
- `pod/<name>-<hash>-<id>` — 1 replica by default
- `service/<name>` — ClusterIP on port 8080 (A2A endpoint)
- `serviceaccount/<name>` — minimal SA used by the pod

Plus the Backstage entity (auto-ingested by TeraSky `kubernetes-ingestor`, ~30-120s after Pod Ready) and a PR-deletion safety annotation that the [decommission wizard](managing-agents.md#decommissioning-an-agent) checks.

## Writing good system messages

Three principles:

**1. State the role in the first sentence.** "You are a release coordinator." not "I am an AI assistant that..."

**2. List delegation rules explicitly.** The agent picks a tool based on your prompt, not magic:

```
## Delegation rules
- For Helm release questions (install/upgrade/rollback) → delegate to helm-agent
- For Kubernetes resource queries → delegate to k8s-agent
- For repo/manifest questions → answer from your own knowledge first, cross-check with k8s-agent
```

**3. Use builtin includes for safety + k8s context.** Saves you from re-writing common safety language:

```
{{include "builtin/safety-guardrails"}}
{{include "builtin/kubernetes-context"}}
```

These resolve at agent-runtime against the `kagent-builtin-prompts` ConfigMap.

**Keep it concise.** Every user message round-trips the full system prompt to the LLM — long prompts inflate token cost on every turn.

## Verifying the agent

After the PR merges and ArgoCD syncs, check the Agent CRD's conditions:

```bash
kubectl get agent -n kagent <name> -o jsonpath='{range .status.conditions[*]}{.type}={.status}({.reason}){"\n"}{end}'
```

Expected output:
```
Accepted=True(Reconciled)
Ready=True(DeploymentReady)
```

And the pod should be running:

```bash
kubectl get pods -n kagent -l kagent.dev/agent=<name>
```

If `Accepted=False`, see the [troubleshooting section](managing-agents.md#troubleshooting) in the management page — most common cause is a delegate agent in `tools[]` that doesn't exist (transitive `promql-agent` dependency is a frequent trap).

## See also

- **[Managing & decommissioning](managing-agents.md)** — view the agent in Backstage, chat with it programmatically, tear it down
- **[Overview](index.md)** — agent inventory + access points
