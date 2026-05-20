# Managing kagent agents

Day-to-day operations: viewing in Backstage, chatting, decommissioning, editing, and the operational gotchas we've hit.

## Viewing an agent in Backstage

Visit `https://backstage.arigsela.com/catalog/default/component/<agent-name>`.

The entity page has 3 tabs:

### Overview

- The standard Backstage entity card (name, description, owner, tags)
- **"About this agent" card** — rendered live from the Agent CRD's `spec.declarative.*` fields. Shows:
    - Full system message (the prompt)
    - A2A skills with examples + tags
    - Delegate agents with human-readable descriptions
    - Configuration table (model config, compaction, resources)
- Hand-edits to the Agent CRD's `systemMessage` are reflected here **immediately** after ArgoCD syncs — no scaffolder cycle needed

### Kubernetes

Standard Backstage K8s tab content:

- Pods, Deployments, ReplicaSets, Services, ServiceAccounts owned by this agent (matched via label selector `app=kagent,app.kubernetes.io/managed-by=kagent,app.kubernetes.io/name=<name>`)
- Pod logs viewable on click
- The Agent CRD itself in the "Custom Resources" section

### Docs

Currently empty for kagent agents — this section-level playbook lives at the IDP level, not per-agent. A future iteration could add per-agent TechDocs if there's agent-specific content worth documenting.

## Chatting with an agent

### kagent UI (browser)

<https://kagent.arigsela.com> — pick the agent, send messages. The UI manages your `contextId` automatically so memory persists across messages in the same chat.

### Programmatic (in-cluster, A2A JSON-RPC)

Useful for scripting agent calls from another in-cluster service:

```bash
curl -X POST http://<agent>.kagent.svc.cluster.local:8080/ \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "contextId": "stable-id-for-cross-session-memory",
        "parts": [{"kind": "text", "text": "your question"}],
        "messageId": "msg-1"
      }
    }
  }'
```

**The `contextId` is load-bearing.** Memory is scoped per `kagent_user_id`, which kagent derives from the request's `contextId`. Each call with a different `contextId` gets a different `kagent_user_id` and won't see prior memories. Use a stable value tied to whatever "user" identity makes sense for your caller (e.g. a Slack user ID, a service account name).

Other useful endpoints:

| Endpoint | What it returns |
|---|---|
| `GET /health` | Liveness check (returns `OK`) |
| `GET /.well-known/agent.json` | A2A discovery — agent capabilities, skills, transport info |
| `GET /openapi.json` | FastAPI OpenAPI 3.1 spec |
| `POST /` with `method: "message/stream"` | Same call, streaming response |

## Decommissioning an agent

Use the **Decommission Kagent Agent** template at `/create`:

1. Choose the template, enter the agent name (e.g. `release-coordinator`)
2. Submit → opens a teardown PR in `arigsela/kubernetes`
3. Review (single-file deletion: `base-apps/kagent/agents/<name>.yaml`), then merge
4. ArgoCD prunes the Agent CRD (~3 min) → kagent controller removes the Deployment/Service automatically → Backstage catalog removes the entity within ~2 min

### Safety: hand-crafted agents are protected

The decommission action refuses to delete agents that don't carry the `arigsela.com/idp-managed: "true"` label. Try to decommission `build-orchestrator` and you'll see:

```
Agent 'build-orchestrator' is not IDP-managed
(missing label arigsela.com/idp-managed=true).
Tear down by hand to avoid removing unrelated files.
```

This is by design — hand-crafted agents must be removed by hand-PRing the YAML deletion. The safety check protects you from accidentally torching `build-orchestrator` or any other non-IDP-managed kagent resource.

## Editing an existing agent

The IDP intentionally doesn't have an "edit" wizard. Edits go via hand-PR:

1. Open `base-apps/kagent/agents/<name>.yaml`
2. Change `spec.declarative.systemMessage`, `tools`, `a2aConfig.skills`, etc.
3. Commit, PR, merge → ArgoCD syncs, kagent reconciles, the running pod restarts with the new config

The "About this agent" card in Backstage reflects the changes immediately after the sync — it fetches live from the Agent CRD, not from the YAML at scaffold time.

## Operator gotchas

These are real issues we've hit. They will get fixed upstream over time; this page should be refreshed when they do.

### "Skills" in the kagent UI ≠ `a2aConfig.skills`

The kagent UI's **"Skill Container Images"** field maps to `spec.skills.refs[]` — a runtime feature where container images are pulled by an init container and mounted into `/skills/` for the agent's runtime to load. This is **different** from `spec.declarative.a2aConfig.skills[]` (the A2A discovery metadata we set via the wizard).

For orchestrator-style agents (like ours), the "Skill Container Images" field is correctly empty — we use agent delegation instead. The A2A skills we defined show up in:

- The agent's A2A `/.well-known/agent.json` endpoint
- The Backstage "About this agent" card

NOT in the kagent UI's edit form.

### Memory recall requires a stable `contextId`

kagent scopes memories per `kagent_user_id`, which is derived from the request's `contextId`. If you call the A2A endpoint with a different `contextId` each time, memories from the previous call won't be visible.

The kagent UI handles this internally (each browser session uses a stable `contextId`). Programmatic clients must pin a stable `contextId` per logical user. See [Chatting with an agent](#chatting-with-an-agent) above.

### Long conversations + Claude 4.x sometimes fail with "system: Input should be a valid array"

This is a bug in `google-adk`'s Anthropic adapter when constructing requests to Claude 4.x models. The error surfaces in the chat UI as:

```
Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error',
'message': 'system: Input should be a valid array'}}
```

**Workaround:** start a new chat. The accumulated conversation context is what triggers the bug; a fresh session avoids the trigger.

**Track:** [google/adk-python issues](https://github.com/google/adk-python/issues) — search for "system: Input should be a valid array".

### observability-agent is currently broken

Its `tools[].agent.name: promql-agent` references an agent that's disabled in our kagent Helm values (`base-apps/kagent.yaml: agents.promql-agent.enabled = false`). kagent's reconciler walks the full delegation graph at acceptance time and fails with:

```
failed to translate agent kagent/<name>:
Agent.kagent.dev "promql-agent" not found
```

**Don't add `observability-agent` as a delegate** to new agents until either (a) we enable `promql-agent` in the Helm values or (b) we override `observability-agent`'s tools list to drop the `promql-agent` reference.

## Troubleshooting

### Agent stuck at `Accepted=False`

```bash
kubectl get agent -n kagent <name> -o jsonpath='{.status.conditions[?(@.type=="Accepted")].message}'
```

Most common causes:

- **A delegate agent in `tools[]` doesn't exist.** Includes transitive dependencies — e.g. delegating to `observability-agent` requires `promql-agent` (which is disabled). Remove the offending delegate.
- **An MCP server name doesn't resolve.** Check `kubectl get remotemcpservers -n kagent` for the names you reference.

### "About this agent" card shows "Could not load agent details"

The Backstage K8s plugin's proxy call failed. Check in order:

1. **RBAC** — the `backstage-kagent-read` ClusterRole exists and is bound to the `backstage` ServiceAccount:
   ```bash
   kubectl get clusterrole backstage-kagent-read
   kubectl get clusterrolebinding backstage-kagent-read
   ```
2. **Entity annotations** — the entity should have `terasky.backstage.io/kubernetes-resource-name` and `kubernetes-resource-namespace`. TeraSky sets these automatically; if missing, the entity wasn't ingested correctly.
3. **Network** — from the Backstage pod, hit the K8s proxy directly:
   ```bash
   kubectl exec -n backstage <pod> -- node -e \
     "fetch('http://localhost:7007/api/kubernetes/proxy/apis/kagent.dev/v1alpha2/namespaces/kagent/agents/<name>',{headers:{'Backstage-Kubernetes-Cluster':'homelab'}}).then(r=>console.log('status:',r.status))"
   ```
   Expect `status: 200`. `403` means RBAC missing. `502` means RBAC denied (Backstage wraps 403 as 502). `5xx` other means the agent CRD is missing or the K8s API is down.

### Pod restart loop

```bash
kubectl logs -n kagent <pod> --tail=200
```

Common causes:

- **Invalid systemMessage template** — bad `{{include}}` reference (e.g. typo in `builtin/...` name)
- **Model API rate limit** — log shows `429 Too Many Requests`
- **Transient Anthropic API error** — log shows `5xx` from `api.anthropic.com`

## See also

- **[Creating an agent](creating-agents.md)** — the wizard walkthrough
- **[Overview](index.md)** — agent inventory + access points
