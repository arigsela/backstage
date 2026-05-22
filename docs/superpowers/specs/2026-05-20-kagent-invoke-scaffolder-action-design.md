# Scaffolder Action: `kagent:agent:invoke` — Design Spec

> **Goal:** Give Backstage scaffolder templates a generic primitive for
> invoking a kagent.dev Agent at template-execution time, so future use
> cases like "suggest skills during agent scaffolding," "translate the
> description," or "validate config inputs" can be expressed as a few
> lines of YAML.
>
> **Status:** Approved design — implementation plan to follow.
> **Date:** 2026-05-20.
> **Author:** Ari Sela (with Claude).
> **Companion contract:** `docs/guides/agent-annotation-contract-v1.md`.

---

## 1. Background

The branch `feat/kagent-v1.8-k8s-tab` (PR #24) ships the
`agents.platform.ai/*` v1 annotation contract on every IDP-managed
kagent Agent. Each agent now carries — in both its K8s CRD and its
auto-ingested catalog entity — a stable `a2a-endpoint` annotation, a
`runtime` discriminator, a list of A2A `skills`, and a `capabilities`
map advertising `{streaming: true, a2a: true}`.

That metadata exists so MCP-backed assistants and other consumers can
**find** agents through the catalog. This spec is about the next step:
letting Backstage itself **call** them.

The first concrete use case is a "suggest skills" wizard step in the
`kagent-agent` template — the user enters a one-sentence agent
description, the template asks a helper agent to propose three skills,
and those suggestions land in the PR for the operator to accept or
edit. The primitive this spec defines is **generic**: any template can
use it for any prompt against any agent, so the suggest-skills feature
is one consumer rather than a special-case action.

## 2. Approach

A new custom scaffolder action `kagent:agent:invoke`, registered
alongside the other seven custom actions in
`packages/backend/src/modules/scaffolder/`. The action is a synchronous
HTTP orchestrator over two calls:

1. **Catalog lookup** to resolve the agent's network endpoint from
   the v1 annotation contract.
2. **A2A `message/send`** to the agent's in-cluster Service, waiting
   synchronously for the response with a hard timeout.

Discovery via the catalog (rather than deriving the URL from the agent
name) dogfoods the v1 contract — proving it's actually useful for the
purpose it was designed for — and future-proofs the action for the day
we add a second agent runtime.

Synchronous one-shot invocation (rather than streaming or task-poll)
matches the existing pattern of our other custom actions and matches
the practical timing of scaffolder runs. Streaming and polling are
explicitly deferred (Section 9).

## 3. Architecture

```
┌───────────────┐                        ┌──────────────────┐
│  Scaffolder   │  1. resolve endpoint   │  Backstage       │
│  step (YAML)  ├──────────────────────► │  Catalog API     │
│               │     (read annotations) │  (in-process)    │
│               │ ◄──────────────────────┤                  │
│               │                        └──────────────────┘
│               │
│  agent name,  │  2. POST message/send  ┌──────────────────┐
│  prompt,      ├──────────────────────► │  kagent Agent    │
│  options      │     (A2A JSON-RPC)     │  Service         │
│               │                        │  *.kagent.svc... │
│               │ ◄──────────────────────┤                  │
│               │     response/error     └──────────────────┘
└───────┬───────┘
        │ output: { response, raw, agentName, runtime, durationMs }
        ▼
   later YAML steps consume the output
```

Three units, all in
`packages/backend/src/modules/scaffolder/kagentInvokeAction.ts`:

- **`kagent:agent:invoke` action** — top-level orchestrator. Owns
  input/output schemas, the timeout budget, and the error taxonomy.
- **`AgentResolver`** (internal helper) — given an agent name, queries
  the catalog and returns `{ endpoint, runtime, contractVersion }` or
  a typed `AgentResolutionError`. Encapsulates contract validation so
  it's unit-testable on its own.
- **`A2AClient`** (internal helper) — given an endpoint and a prompt,
  performs one `POST` with the A2A `message/send` body. Owns timeout,
  single network-error retry, and HTTP-status taxonomy.

All three live in one file (~250 lines projected). This matches the
existing convention — every other custom action is a single
self-contained file. If the file grows past ~400 lines we split.

**In-cluster traffic only.** Both HTTP calls stay inside the Backstage
backend pod and `kagent.svc.cluster.local`. There's no auth header in
v1. Outside the cluster (local dev) the action fails cleanly with a
helpful `ENDPOINT_UNREACHABLE` and the documented requirement that it
needs in-cluster execution.

## 4. Action contract

**Action ID:** `kagent:agent:invoke`

### Inputs

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | — | Agent name as it appears in the catalog (matches `metadata.name` on the CRD). Validated against `^[a-z][a-z0-9-]{2,38}[a-z0-9]$`. |
| `prompt` | string | yes | — | The user message to send. Min length 1, max length 8000. |
| `expectJson` | boolean | no | `false` | When `true`, parse the response as JSON and fail with `INVALID_RESPONSE_JSON` if parsing fails. |
| `timeoutMs` | integer | no | `120000` | Hard cap on the A2A HTTP call. Min 5000, max 300000. |
| `onError` | enum: `fail` \| `continue` | no | `fail` | `fail` aborts the scaffolder run; `continue` returns the error in outputs and lets later steps decide. |

### Outputs

| Field | Type | Description |
| --- | --- | --- |
| `response` | string \| unknown | Plain text response, or parsed JSON when `expectJson: true`. |
| `agentName` | string | Echoed input for downstream interpolation convenience. |
| `runtime` | string | From the agent's `agents.platform.ai/runtime` annotation. |
| `durationMs` | integer | Wall-clock time for the full action (resolution + invocation). |
| `error` | object \| null | Populated only when `onError: continue` and the call failed: `{ code, message }`. Always `null` on success. |

### Error codes

| Code | Cause |
| --- | --- |
| `AGENT_NOT_FOUND` | Catalog lookup returned 404. |
| `INVALID_CONTRACT` | Entity exists but contract version, runtime, or `a2a-endpoint` annotation is missing/unsupported. |
| `ENDPOINT_UNREACHABLE` | DNS failure or `ECONNREFUSED` after retry. |
| `INVOCATION_TIMEOUT` | Exceeded `timeoutMs`. |
| `AGENT_ERROR` | Agent returned HTTP 4xx/5xx, or a JSON-RPC `error` envelope. |
| `INVALID_RESPONSE_JSON` | `expectJson: true` but body wasn't parseable JSON. |

### Example usage

```yaml
- id: suggest-skills
  name: Ask skill-suggester for proposed skills
  action: kagent:agent:invoke
  input:
    name: skill-suggester
    prompt: |
      Suggest 3 A2A skills for an agent described as:
      "${{ parameters.description }}"
      Respond with a JSON array: [{"id":"kebab-case","name":"Title","description":"one sentence"}]
    expectJson: true
    onError: continue   # don't block the PR if the suggester is down
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

## 5. Catalog discovery

The `AgentResolver` makes one HTTP call to the local Backstage catalog
plugin.

**Endpoint:** `GET ${BACKSTAGE_API_BASE}/api/catalog/entities/by-name/component/default/<name>`

`BACKSTAGE_API_BASE` resolves from the `RootConfig` injected by
Backstage's DI system — the same pattern other custom actions use for
`app.baseUrl`. In-cluster this resolves to `http://localhost:7007`. No
network hop leaves the pod.

**Auth:** none. The catalog API accepts unauthenticated reads on
`localhost` by default. If we later harden permissions, the action
plugs into `ServiceRef<DiscoveryService>` to get a service-to-service
token automatically.

**Validation order** (fail-fast on the first issue):

1. HTTP 404 → `AGENT_NOT_FOUND` with `"No catalog entity 'component:default/<name>'. Has the kagent Agent been ingested yet?"`
2. HTTP non-200 → `INVALID_CONTRACT` with the upstream status code attached
3. `spec.type != "kagent-agent"` → `INVALID_CONTRACT` with `"Entity is not a kagent-agent (got type: <type>)"`
4. `agents.platform.ai/version != "v1"` → `INVALID_CONTRACT` with `"Unsupported contract version: <version>"`
5. `agents.platform.ai/runtime != "kagent"` → `INVALID_CONTRACT` with `"Unsupported runtime: <runtime>"`. (Other runtimes get separate actions later.)
6. `agents.platform.ai/a2a-endpoint` missing or not a valid URL → `INVALID_CONTRACT`
7. Endpoint hostname doesn't end in `.svc.cluster.local` → **warn but allow** (port-forward use case during local testing). Logged at warn level.

**Caching:** none in v1. Catalog calls are local and fast (~10ms).
Adding an in-memory TTL cache later if profiling shows it matters.

## 6. A2A wire format

kagent.dev implements the Google A2A protocol (JSON-RPC 2.0 over HTTP).
The implementation **must probe and pin** the exact endpoint and method
names in implementation Task 1 — kagent's wire format may differ from
upstream A2A in minor ways. If the probe disagrees with the assumed
shape below, the implementation is updated before merge and this
section is amended.

### Assumed shape (subject to Task 1 probe)

- Request: `POST <a2a-endpoint>/` with `Content-Type: application/json`:
  ```json
  {
    "jsonrpc": "2.0",
    "id": "<scaffolder-step-id>",
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "type": "text", "text": "<prompt>" }]
      }
    }
  }
  ```
- Success: HTTP 200 with
  `{ "jsonrpc": "2.0", "id": "...", "result": { "parts": [{"type":"text","text":"..."}] } }`.
  The action concatenates all `text` parts in order to produce the
  `response` output.
- Error: HTTP 200 with
  `{ "jsonrpc": "2.0", "id": "...", "error": { "code": -32xxx, "message": "..." } }`,
  OR HTTP 4xx/5xx. Both surface as `AGENT_ERROR`.

### HTTP client

Node 20's built-in `fetch` — no new dependency.

### Timeout

`AbortController` with the configured `timeoutMs`. On timeout, the
action throws `INVOCATION_TIMEOUT` and the abort propagates to release
the socket. The action does NOT swallow the abort — leaving Node with
a half-open socket would leak file descriptors on long sessions.

### Retry policy

One retry on network-layer failure only (DNS resolution, ECONNRESET,
ECONNREFUSED). No retry on HTTP errors (the agent already saw the
request — retrying could double-execute side effects). No retry on
timeout (we're already past the budget). Single retry uses 500ms
backoff. Total worst-case wall time stays bounded at `timeoutMs + 500ms`.

### Logging

Uses `ctx.logger`, same pattern as `kagentValidateNameAction`:

- Info: `"kagent:agent:invoke — resolving '<name>'"`
- Info: `"kagent:agent:invoke — endpoint=<endpoint> runtime=<runtime>"`
- Info: `"kagent:agent:invoke — POST <endpoint> (prompt: <len> chars)"`
- Info: `"kagent:agent:invoke — response received in <ms>ms (length: <n> chars)"`
- Warn: `"kagent:agent:invoke — retrying after network error: <code>"`
- Error: `"kagent:agent:invoke — <code>: <message>"` (only on failure)

### Prompt size guard

The action rejects prompts > 8000 chars at the zod input schema.
Catches accidental megaprompts before we send.

### No streaming in v1

`message/send` is the synchronous A2A method. `message/stream` is
explicitly out of scope (Section 9).

## 7. Testing strategy

Three layers, mirroring the AIContext-contract pattern used elsewhere
on this branch.

### Layer 1 — unit tests

Lives at
`packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`.
Same harness shape as `kagentValidateNameAction.test.ts`. Uses `nock`
(already in devDependencies) to mock both the catalog API and the A2A
endpoint.

Test cases:

1. Happy path — catalog returns valid v1 entity, A2A returns text → action returns the text.
2. Happy path with `expectJson: true` — A2A returns JSON-string text → action returns parsed object.
3. `AGENT_NOT_FOUND` — catalog 404.
4. `INVALID_CONTRACT` — catalog returns entity with `agents.platform.ai/version: v99`.
5. `INVALID_CONTRACT` — entity missing `a2a-endpoint` annotation.
6. `INVALID_CONTRACT` — entity has `runtime: crewai`.
7. `ENDPOINT_UNREACHABLE` — A2A endpoint ECONNREFUSED → retried once → still failed → typed error.
8. `INVOCATION_TIMEOUT` — A2A endpoint never responds → AbortController fires at `timeoutMs`.
9. `AGENT_ERROR` — A2A returns HTTP 500.
10. `INVALID_RESPONSE_JSON` — `expectJson: true` but response is `"not json"`.
11. `onError: continue` semantics — same failure as test 7, but `onError: continue` returns `error` in output instead of throwing.
12. `durationMs` — set to a value > 0 on success.
13. Input validation — prompt > 8000 chars rejected by zod before any HTTP call.
14. Input validation — agent name failing the regex rejected.

Target: ≥90% line coverage of the new file. Run via the existing
`yarn workspace backend test` — no new test infrastructure.

### Layer 2 — manual operator validation (one-time during impl)

Run against the deployed Backstage talking to a real kagent agent.
Steps recorded in the implementation plan:

1. Create a stub `skill-suggester` kagent agent via the existing wizard.
2. Wait for ArgoCD sync and TeraSky ingestion (~30s).
3. Write a throwaway test template that calls `kagent:agent:invoke` with a hardcoded prompt.
4. Run the template from the Backstage UI.
5. Assert: action completes within timeout, returns a non-empty response, the log line shows the resolved endpoint.

This is the gate that pins the A2A wire format from Section 6. If the
probe disagrees with the assumed shape, the implementation is updated
before merge.

### Layer 3 — end-to-end smoke (deferred to follow-up PR)

Wire a Tech Insights check that scans the catalog for entities with
`agents.platform.ai/runtime: kagent`, sends each a no-op "ping" prompt,
and reports liveness. Out of scope for this spec — flagged in
Section 9.

### What we deliberately don't test

- Cross-service real-network paths (covered by Layer 2 manual gate).
- Performance characteristics — no requirement that calls land in <X ms; the user-facing timeout *is* the contract.
- Concurrent scaffolder runs hitting the same agent — kagent owns concurrency; we'd just be testing their behavior.

## 8. Rollout & security

### Rollout (no feature flag; deploys with the next image build)

1. Action is registered in `packages/backend/src/modules/scaffolder/index.ts` alongside the other seven — automatically available to every template once the image deploys.
2. **In scope:** the action itself + its tests + docs. **Out of scope for this spec:** any template that consumes the action (e.g., a "suggest skills" step in the `kagent-agent` wizard). That consumer is a follow-up — designed once the action is proven via Layer 2 manual validation.
3. No new dependencies, no new env vars, no new RBAC. The Backstage ServiceAccount already has the catalog-read and outbound-HTTP it needs.
4. Roll-back is a single Git revert + image rebuild. State-free.

### Security

- **No outbound traffic leaves the cluster.** All HTTP calls stay in-cluster (catalog API on `localhost:7007`, kagent agents on `*.kagent.svc.cluster.local:8080`). Backstage's NetworkPolicy doesn't need updates.
- **No secrets handled.** No tokens, API keys, or credentials touch this action.
- **Prompt as code, not data.** The prompt is rendered from the template YAML by Nunjucks before it reaches the action. Templates are checked into Git and reviewed via PR. There's no "user free-text → agent prompt" path that bypasses review.
- **Untrusted agent responses.** Agent text flows into downstream scaffolder steps (PR body, rendered YAML). The action does not sanitize. Templates that interpolate the response into shell commands, file paths, or anything executable MUST treat it as untrusted. Documented in the action's `description` string.
- **Resource exhaustion.** `timeoutMs` (max 300s) and `prompt` length cap (8000 chars) prevent one runaway template from holding scaffolder workers indefinitely. Concurrent scaffolder steps are already capped by Backstage.

### Forward compatibility

- The action ID is `kagent:agent:invoke` — kagent-specific. When/if we add a `crewai:agent:invoke` it lives in a sibling action, sharing the AgentResolver via extraction. The annotation-driven discovery makes this clean: just check `runtime`.
- If RFC #33575 (`AIContext` kind) lands upstream, the resolver gains a second code path that prefers `AIContext.spec.endpoint` over `agents.platform.ai/a2a-endpoint`, both feeding the same `EndpointInfo` struct. No template-facing change.
- v2 of the contract (`agents.platform.ai/version: v2`) gets added to the validation allowlist when we adopt it. v1 entities keep working.

## 9. Out of scope (each is its own follow-up)

- **In-tree consumers.** The `kagent-agent` "suggest skills" wizard step, and any other template that wires `kagent:agent:invoke` into a real flow, is a follow-up PR. This spec ships the primitive only.
- **Streaming responses** (`message/stream` SSE). Action API doesn't expose deltas; deferred until a custom UI field needs them.
- **Multi-turn conversations.** No session state in v1. Each call is independent.
- **The custom UI field** (Option 2 follow-up). This spec builds the backend primitive that field would call.
- **`crewai:agent:invoke` sibling.** Different runtime, different protocol — needs its own design pass.
- **Tech Insights / scorecard checks** that exercise this action.
- **Auth / mTLS.** Cluster-internal trust only in v1.
- **Caching** of agent responses across scaffolder runs.

## 10. References

- `docs/guides/agent-annotation-contract-v1.md` — the v1 annotation contract this action consumes.
- `docs/superpowers/specs/2026-05-19-aicontext-catalog-kind-design.md` — design of the annotation contract.
- `packages/backend/src/modules/scaffolder/kagentValidateNameAction.ts` — reference implementation pattern.
- `packages/backend/src/modules/scaffolder/index.ts` — extension-point registration.
- A2A protocol spec: https://github.com/google/agent-to-agent
- kagent.dev: https://kagent.dev
