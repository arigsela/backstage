# Scaffolder Action: `kagent:agent:invoke`

> Synchronously call a kagent.dev Agent from any Backstage scaffolder
> template. Returns the agent's text response (or parsed JSON) for use
> in later steps.
>
> Design spec: `docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md`

## When to use this

You want to enrich a scaffolder run with agent intelligence — e.g., have
an agent suggest A2A skill metadata based on a one-line description,
translate a description, validate user inputs, or generate boilerplate
content for a PR body.

## Pre-requisites

- The target agent exists in the catalog as `Component` with
  `spec.type: kagent-agent`, ingested by TeraSky's kubernetes-ingestor
  directly from a kagent 1.0 `api.kagent.dev/v1alpha3` Agent (the Agent
  carries `terasky.backstage.io/add-to-catalog: "true"` and
  `terasky.backstage.io/component-type: kagent-agent`; see
  `kubernetesIngestor.components.customWorkloadTypes` in `app-config.yaml`).
- Backstage can reach the kagent controller. The action resolves the agent
  through the catalog, then calls the controller's A2A gateway at
  `<kagent.a2aBaseUrl>/agents/<namespace>/<name>` (default
  `http://kagent-controller.kagent.svc.cluster.local:8083`).

## Wire format (kagent 1.0)

A2A v1 JSON-RPC, verified against kagent `v1.0.0-alpha11`
(`docs/architecture/a2a-transports.md`) and the a2a-go v2.6.0 encoding:

```json
POST /agents/kagent/skill-suggester
A2A-Version: 1.0
X-User-Id: backstage-portal

{"jsonrpc": "2.0", "id": "<task id>", "method": "SendMessage",
 "params": {"message": {"messageId": "<uuid>", "role": "ROLE_USER",
                        "parts": [{"text": "..."}]}}}
```

The reply is `result.task` (`status.state` is `TASK_STATE_*`; the answer is
the text parts of `status.message` and `artifacts[]`, while `data` parts are
tool calls and are skipped) or `result.message`. No `contextId` is sent, so
every call is a new kagent Session owned by the `X-User-Id` user. A JSON-RPC
`-32004` whose ErrorInfo `metadata.reason` is `KAGENT_SEND_NOT_ACCEPTED` is
retried with the same message for up to 30 s; nothing else is.

## Action contract

### Inputs

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `name` | string | yes | — |
| `prompt` | string (1..8000 chars) | yes | — |
| `expectJson` | boolean | no | `false` |
| `timeoutMs` | integer (5000..300000) | no | `120000` |
| `onError` | `fail` \| `continue` | no | `fail` |

### Outputs

| Field | Type |
| --- | --- |
| `response` | string \| any (parsed when `expectJson: true`) |
| `agentName` | string |
| `runtime` | string |
| `durationMs` | integer |
| `error` | `{code, message}` \| `null` |

### Error codes

`AGENT_NOT_FOUND`, `INVALID_CONTRACT`, `ENDPOINT_UNREACHABLE`,
`INVOCATION_TIMEOUT`, `AGENT_ERROR`, `INVALID_RESPONSE_JSON`.

## Example: "suggest skills" wizard step

```yaml
- id: suggest-skills
  name: Ask skill-suggester for proposed A2A skills
  action: kagent:agent:invoke
  input:
    name: skill-suggester
    prompt: |
      Suggest 3 A2A skills for an agent described as:
      "${{ parameters.description }}"
      Respond with a JSON array: [{"id":"kebab-case","name":"Title","description":"one sentence"}]
    expectJson: true
    onError: continue
    timeoutMs: 60000

- id: write-pr-body
  action: ...
  input:
    body: |
      Description: ${{ parameters.description }}
      {% if steps['suggest-skills'].output.error %}
      (Skill suggestions unavailable: ${{ steps['suggest-skills'].output.error.code }})
      {% else %}
      Suggested skills:
      ${{ steps['suggest-skills'].output.response | dump }}
      {% endif %}
```

## Security notes

- **Agent responses are untrusted.** Treat them as adversarial text. Do
  not interpolate the response into shell commands, file paths, or
  anything executable without sanitization. The action does no
  sanitization of its own.
- **Prompts are reviewed code.** They come from the template YAML,
  which is checked into Git and reviewed. There's no end-user
  free-text→agent-prompt path. If you add one, you become responsible
  for prompt-injection defense.
- **No outbound traffic from the cluster.** Both HTTP calls
  (Backstage→catalog, Backstage→agent) stay inside the cluster.

## Troubleshooting

| Error code | Likely cause | Fix |
| --- | --- | --- |
| `AGENT_NOT_FOUND` | Catalog hasn't ingested the agent yet, or wrong name | Wait ~30s after creating the agent; confirm `kubectl get agents.kagent.dev -n kagent` shows it; check the spelling of `name` in the action input. |
| `INVALID_CONTRACT: ... not a kagent 1.0 Agent` | The entity was ingested from something other than an `api.kagent.dev` Agent (e.g. a stale kagent 0.10 Deployment entity) | Check `kubectl get agents.api.kagent.dev -n kagent`; the entity's `terasky.backstage.io/kubernetes-resource-kind` must be `Agent`. |
| `ENDPOINT_UNREACHABLE` | Backstage is running outside the cluster (e.g., local dev), or the kagent controller is down | Run inside the cluster, or `kubectl port-forward -n kagent svc/kagent-controller 8083` and set `kagent.a2aBaseUrl: http://127.0.0.1:8083` in `app-config.local.yaml`. |
| `INVOCATION_TIMEOUT` | Agent is slow; default 120s wasn't enough | Increase `timeoutMs` (max 300000) or simplify the prompt. |
| `AGENT_ERROR` | HTTP 4xx/5xx, a JSON-RPC error, or a task that failed or paused for an approval | The message carries the task state and status text. Check `kubectl logs -n kagent deploy/kagent-controller` and the Session (owned by `backstage-portal`) in the kagent UI. |
| `INVALID_RESPONSE_JSON` | `expectJson: true` but the agent's text wasn't valid JSON | Tighten the prompt ("Respond with valid JSON, nothing else."), or set `expectJson: false` and parse downstream. |

## Forward compatibility

- Streaming responses (`SendStreamingMessage`) are not exposed. They'll
  arrive when a custom UI field needs them.
- Multi-turn use (sending the returned `contextId` back) is not exposed;
  each invocation is a fresh Session.
