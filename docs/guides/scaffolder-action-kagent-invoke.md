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
  `spec.type: kagent-agent` (auto-ingested by TeraSky's
  kubernetes-ingestor from a `kagent.dev/v1alpha2` Agent CRD).
- The agent carries the `agents.platform.ai/*` v1 contract annotations
  (every IDP-scaffolded agent does — see
  `docs/guides/agent-annotation-contract-v1.md`).
- Backstage is running in-cluster (the action calls the agent at its
  `*.kagent.svc.cluster.local` Service URL).

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
| `INVALID_CONTRACT: Unsupported contract version: v2` | The agent was scaffolded with a future v2 contract | Upgrade Backstage to support v2 (not yet implemented). |
| `INVALID_CONTRACT: Unsupported runtime: <other>` | Trying to invoke a non-kagent agent | This action is kagent-specific. Use a sibling `<runtime>:agent:invoke` action when one exists. |
| `ENDPOINT_UNREACHABLE` | Backstage is running outside the cluster (e.g., local dev), or the agent's Service is down | Run inside the cluster, or port-forward and override the annotation for local testing. |
| `INVOCATION_TIMEOUT` | Agent is slow; default 120s wasn't enough | Increase `timeoutMs` (max 300000) or simplify the prompt. |
| `AGENT_ERROR` | Agent returned HTTP 4xx/5xx or a JSON-RPC error | Check the agent's pod logs: `kubectl logs -n kagent deploy/<name>` |
| `INVALID_RESPONSE_JSON` | `expectJson: true` but the agent's text wasn't valid JSON | Tighten the prompt ("Respond with valid JSON, nothing else."), or set `expectJson: false` and parse downstream. |

## Forward compatibility

- A v2 contract will add fields like `system-message-digest` and
  `disciplines`. The action will accept v2 annotations as soon as
  Backstage is updated. v1 entities keep working.
- A `crewai:agent:invoke` sibling action will live alongside this one
  when CrewAI agents need the same treatment.
- Streaming responses (`message/stream`) are not exposed in v1. They'll
  arrive when a custom UI field needs them.
