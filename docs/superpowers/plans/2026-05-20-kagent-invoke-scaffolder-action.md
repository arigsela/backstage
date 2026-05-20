# `kagent:agent:invoke` Scaffolder Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `kagent:agent:invoke` custom scaffolder action so any Backstage template can synchronously invoke a kagent.dev Agent via the A2A protocol.

**Architecture:** One new file in `packages/backend/src/modules/scaffolder/` containing three internal units (action handler, `AgentResolver`, `A2AClient`). Discovery uses the catalog API to read the `agents.platform.ai/*` v1 annotation contract. Invocation uses A2A `message/send` over Node 20's built-in `fetch` with `AbortController` for timeout and one retry on network-layer failure. The first in-tree consumer (e.g., a "suggest skills" wizard step) is **out of scope** — covered by a follow-up plan after Layer 2 manual validation lands.

**Tech Stack:** TypeScript, Backstage New Backend System extension-point pattern, Jest, Node 20 built-in `fetch` / `AbortController`, zod via `createTemplateAction` schema. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md`.

---

## Layer 2 Validation Result (2026-05-20)

Successfully invoked `dnd-agent` end-to-end from a Backstage scaffolder
template using the new `kagent:agent:invoke` action.

| Field | Value |
| --- | --- |
| Agent | `dnd-agent` |
| Runtime | `kagent` |
| Prompt | `"Say hello in one short sentence."` (32 chars) |
| Duration | **5408ms** wall-clock |
| Response length | 63 chars |
| Response | *"Greetings, adventurer! Welcome to your next epic D&D adventure."* |
| Error field | `null` |

Backend log lines confirm the action ran the resolver → A2A flow:

```
info: kagent:agent:invoke — resolving 'dnd-agent'
info: kagent:agent:invoke — endpoint=http://dnd-agent.kagent.svc.cluster.local:8080 runtime=kagent
info: kagent:agent:invoke — POST http://dnd-agent.kagent.svc.cluster.local:8080 (prompt: 32 chars)
info: kagent:agent:invoke — response received in 5408ms (length: 63 chars)
```

The wire format pinned by Task 1's probe (JSON-RPC `message/send` with
`messageId`, response read from `.result.artifacts[0].parts[0].text`,
parts keyed by `kind` not `type`) worked unmodified. No spec deltas
discovered during live validation.

The validation traveled through 5 redeploys before landing — three
gotchas surfaced and are now memorialized:

1. `createTemplateAction` `schema.input` zod constraints are
   UI-form-only — they don't enforce at handler call time. Fixed by
   adding manual runtime validation in commit `b59371b`.
2. Backstage config layering merges objects but **replaces arrays**.
   `catalog.locations` added only to `app-config.yaml` had no effect on
   the deployed instance — needed mirroring in
   `app-config.production.yaml` with a different path prefix.
   Memorialized in the user's auto-memory (`feedback-production-config-replaces-arrays`).
3. Entity names must start with `[a-zA-Z0-9]` — a leading underscore in
   `metadata.name: _test-kagent-invoke` was silently rejected with no
   error log. Renamed to `test-kagent-invoke` in commit `8311c98`.

Throwaway template (`examples/templates/_test-kagent-invoke/`) and its
two config-locations entries will be removed in the next commit.

---

## A2A Probe Findings (2026-05-20)

**Request URL:** `POST http://dnd-agent.kagent.svc.cluster.local:8080/`

**Request body:**
```json
{
  "jsonrpc": "2.0",
  "id": "probe-2",
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "msg-probe-1",
      "role": "user",
      "parts": [{"type": "text", "text": "Say hi in one word."}]
    }
  }
}
```

**Successful response (truncated):**
```json
{
  "id": "probe-2",
  "jsonrpc": "2.0",
  "result": {
    "artifacts": [
      {
        "artifactId": "31b2be33-ab8c-41b4-a9cb-9d8f037b404f",
        "parts": [{"kind": "text", "text": "Greetings!"}]
      }
    ],
    "contextId": "33863faa-d569-417e-9c41-d2be871fd36b",
    "id": "f55d8a72-2998-48bc-8ff0-7cd73f3e8103",
    "kind": "task",
    "status": {"state": "completed", "timestamp": "2026-05-20T15:34:40.823818+00:00"}
  }
}
```

**Response text path:** `.result.artifacts[0].parts[0].text`

**Error reporting:** Always HTTP 200; errors returned as JSON-RPC envelope. Validation errors use code `-32602` (Invalid params) with a `data` array of Pydantic errors. Unknown methods use code `-32601` (Method not found). No non-200 HTTP statuses observed for protocol-level errors.

**Spec delta:**
1. **`params.message.messageId` is required** — the spec's assumed shape omits it; the agent returns a `-32602` validation error without it. The `A2AClient` must generate and supply a unique `messageId` (e.g., `crypto.randomUUID()`).
2. **`params.message.parts[].type` field is accepted on input** but the response uses `parts[].kind` (not `parts[].type`). Input uses `type: "text"`; output uses `kind: "text"`. Both convey the same content field `text`.
3. **Response text is in `.result.artifacts[0].parts[0].text`**, not `.result.parts[].text` as the spec assumed. The top-level task result wraps the reply inside an `artifacts` array, not a flat `parts` array.
4. **Protocol version is `0.3.0`** (confirmed via `GET /.well-known/agent.json`). The agent card also confirms `preferredTransport: "JSONRPC"` and the A2A endpoint URL as `http://dnd-agent.kagent:8080`.

The `A2AClient` in Task 4 must use this probed shape — not the spec's assumed shape if they differ.

---

## File Structure

| Path | Action | Purpose |
| --- | --- | --- |
| `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts` | Create | Action handler + `AgentResolver` + `A2AClient` + `AgentInvocationError`. |
| `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts` | Create | Unit tests using `jest.spyOn(global, 'fetch')`. |
| `packages/backend/src/modules/scaffolder/index.ts` | Modify | Add `coreServices.discovery` to deps; register the new action. |
| `docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md` | Modify (Task 1) | Append probed A2A wire format under "A2A Probe Findings". |
| `docs/guides/scaffolder-action-kagent-invoke.md` | Create | Operator-facing usage guide. |

---

## Task 1: Probe the live A2A wire format against a real agent

**Why this task exists**: the design spec (Section 6) explicitly calls out that kagent's A2A dialect may differ from the assumed shape. Implementation must pin the actual request/response shape before writing the `A2AClient`. This is a **research-only** task. No code, no commit on action files — only an amendment to this plan recording the findings.

**Files:**
- Modify: `docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md` (append "A2A Probe Findings" section)

- [ ] **Step 1: Identify a live kagent agent to probe**

Confirm `dnd-agent` (or another kagent.dev/v1alpha2 Agent) is running in the cluster:

```bash
kubectl get agents.kagent.dev -n kagent
```

Expected: at least one Agent listed with `READY` status.

If no Agent is running, deploy one via the existing scaffolder template before continuing.

- [ ] **Step 2: Find a probe pod inside the cluster**

The A2A endpoint is `http://<name>.kagent.svc.cluster.local:8080` — only reachable from inside the cluster.

Either:
- Use the Backstage backend pod: `kubectl exec -n backstage deploy/backstage -- /bin/sh`, or
- Run a short-lived debug pod: `kubectl run -n kagent -it --rm probe --image=curlimages/curl --restart=Never -- sh`

- [ ] **Step 3: Probe variant 1 — assumed shape (POST / with message/send)**

From inside the probe pod, send the assumed shape:

```bash
curl -sS -X POST http://dnd-agent.kagent.svc.cluster.local:8080/ \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "probe-1",
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"type": "text", "text": "Say hi in one word."}]
      }
    }
  }' | head -200
```

Record:
- HTTP status code
- Full response body (or first 200 chars)

- [ ] **Step 4: If variant 1 fails, probe variant 2 — alternative endpoints**

If variant 1 returns 404 or "method not found", try in order:

```bash
# Variant 2a: /v1/messages
curl -sS -X POST http://dnd-agent.kagent.svc.cluster.local:8080/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"role":"user","parts":[{"type":"text","text":"Say hi in one word."}]}'

# Variant 2b: /tasks
curl -sS -X POST http://dnd-agent.kagent.svc.cluster.local:8080/tasks \
  -H 'Content-Type: application/json' \
  -d '{"message":{"role":"user","parts":[{"type":"text","text":"Say hi in one word."}]}}'

# Variant 2c: agent card discovery first
curl -sS http://dnd-agent.kagent.svc.cluster.local:8080/.well-known/agent.json
```

Record the first variant that returns 200 with text in the response body.

- [ ] **Step 5: Document findings in the plan**

Append a new section to this file directly below the "Tech Stack" header line, titled `## A2A Probe Findings (2026-05-20)`. Include:

1. **Request URL** (full path, including any subpath like `/` or `/v1/messages`)
2. **Request body** (the exact JSON-RPC envelope, including method name)
3. **Response shape**: where the text lives (`result.parts[].text` or another path)
4. **Error shape**: how the agent reports errors (HTTP status, or 200 with `error` envelope)
5. **One-paragraph summary** confirming the spec's Section 6 assumed shape is correct, OR listing the deltas

Concrete schema for the section:

```markdown
## A2A Probe Findings (2026-05-20)

**Request URL:** `POST <path>`

**Request body:**
```json
<actual JSON sent>
```

**Successful response (truncated):**
```json
<actual response body, first 500 chars>
```

**Response text path:** `<jq-style path, e.g. .result.parts[].text>`

**Error reporting:** `<HTTP status N or JSON-RPC error envelope>`

**Spec delta:** `<none | list deltas>`

The `A2AClient` in Task 4 must use this probed shape — not the spec's assumed shape if they differ.
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md
git commit -m "docs(plan): record A2A wire format probe findings

Probed http://dnd-agent.kagent.svc.cluster.local:8080 with the assumed
JSON-RPC message/send envelope; findings pin the exact wire format for
the upcoming A2AClient implementation."
```

---

## Task 2: Skeleton action with input schema and failing input-validation tests

Establish the file, the input schema, and the simplest possible failing test. The handler throws `"not implemented"` initially — Tasks 3–5 fill it in.

**Files:**
- Create: `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts`
- Create: `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`

- [ ] **Step 1: Write the failing input-validation tests**

Create `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`:

```typescript
/**
 * Unit tests for kagent:agent:invoke action.
 *
 * Mocks:
 *   - global.fetch via jest.spyOn (covers both catalog and A2A HTTP calls).
 *   - DiscoveryService via a plain object literal.
 *   - ActionContext via a local helper (the upstream createMockActionContext
 *     is not exported from @backstage/plugin-scaffolder-node@0.12.5).
 */

import { createKagentInvokeAction } from './kagentInvokeAction';

function mockDiscovery(catalogBase = 'http://localhost:7007/api/catalog') {
  return {
    getBaseUrl: jest.fn().mockResolvedValue(catalogBase),
    getExternalBaseUrl: jest.fn().mockResolvedValue(catalogBase),
  } as any;
}

function createMockActionContext(opts: {
  input: Record<string, unknown>;
  taskId?: string;
}) {
  return {
    input: opts.input,
    output: jest.fn(),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    },
    workspacePath: '/tmp/test-workspace',
    checkpoint: jest.fn(),
    createTemporaryDirectory: jest.fn().mockResolvedValue('/tmp/test-temp'),
    getInitiatorCredentials: jest.fn(),
    task: { id: opts.taskId ?? 'test-task-id' },
  } as any;
}

describe('kagent:agent:invoke — input validation', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('rejects empty prompt', async () => {
    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: '' },
    });
    await expect(action.handler(ctx)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects prompt over 8000 chars', async () => {
    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'x'.repeat(8001) },
    });
    await expect(action.handler(ctx)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid agent name', async () => {
    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'INVALID_NAME', prompt: 'hello' },
    });
    await expect(action.handler(ctx)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects timeoutMs below 5000', async () => {
    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hello', timeoutMs: 1000 },
    });
    await expect(action.handler(ctx)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects timeoutMs above 300000', async () => {
    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hello', timeoutMs: 999999 },
    });
    await expect(action.handler(ctx)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests — they fail because the module doesn't exist**

```bash
yarn workspace backend test --testPathPattern=kagentInvokeAction
```

Expected: FAIL with `Cannot find module './kagentInvokeAction'`.

- [ ] **Step 3: Create the action skeleton with the input schema**

Create `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts`:

```typescript
/**
 * Custom Scaffolder Action: kagent:agent:invoke
 * ==============================================
 *
 * Synchronously invokes a kagent.dev Agent via the A2A protocol. Discovery
 * uses the agents.platform.ai/* v1 annotation contract on the auto-ingested
 * catalog entity. Designed to be called from any Backstage scaffolder
 * template — e.g., a "suggest skills" wizard step.
 *
 * IMPORTANT: agent responses are untrusted text. Templates that interpolate
 * the response into shell commands, file paths, or anything executable MUST
 * treat it as adversarial input.
 *
 * Companion spec: docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { DiscoveryService } from '@backstage/backend-plugin-api';

export class AgentInvocationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}

export function createKagentInvokeAction(opts: { discovery: DiscoveryService }) {
  const { discovery } = opts;

  return createTemplateAction({
    id: 'kagent:agent:invoke',
    description:
      'Synchronously invokes a kagent.dev Agent via A2A. Returns its text response. ' +
      'WARNING: agent responses are untrusted — never interpolate into shell commands ' +
      'or file paths without sanitization.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/)
            .describe('Agent name as it appears in the catalog (matches the CRD metadata.name).'),
        prompt: z =>
          z
            .string()
            .min(1)
            .max(8000)
            .describe('User message to send to the agent.'),
        expectJson: z =>
          z
            .boolean()
            .optional()
            .describe('When true, parse the response as JSON.'),
        timeoutMs: z =>
          z
            .number()
            .int()
            .min(5000)
            .max(300000)
            .optional()
            .describe('Hard timeout for the A2A call (default 120000).'),
        onError: z =>
          z
            .enum(['fail', 'continue'])
            .optional()
            .describe('fail aborts the run; continue surfaces the error in outputs.'),
      },
      output: {
        response: z =>
          z
            .union([z.string(), z.unknown()])
            .describe('The agent text response, or parsed JSON when expectJson:true.'),
        agentName: z => z.string().describe('Echoed input.'),
        runtime: z => z.string().describe('From agents.platform.ai/runtime annotation.'),
        durationMs: z => z.number().int().describe('Wall-clock duration in ms.'),
        error: z =>
          z
            .union([z.null(), z.object({ code: z.string(), message: z.string() })])
            .describe('Populated only when onError:continue and the call failed.'),
      },
    },

    async handler(_ctx) {
      // Filled in by Tasks 3–5.
      throw new Error('kagent:agent:invoke: not yet implemented');
    },
  });
}

// Discovery is used here so the import isn't dropped before the handler is
// wired in Task 5. Remove this when handler uses discovery directly.
void discovery;
```

- [ ] **Step 4: Run the tests — input-validation tests now pass**

```bash
yarn workspace backend test --testPathPattern=kagentInvokeAction
```

Expected: 5 PASS (input-validation tests). The skeleton throws "not yet implemented" but that's after schema validation, so the input-validation tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/modules/scaffolder/kagentInvokeAction.ts \
        packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts
git commit -m "feat(kagent): scaffold kagent:agent:invoke action with input schema

Establishes the new custom scaffolder action's file structure, input
validation (zod), and a failing handler stub. Subsequent tasks fill in
AgentResolver, A2AClient, and the orchestration logic. Test coverage:
input validation only (5 cases)."
```

---

## Task 3: Implement `AgentResolver` (catalog discovery)

Resolve `name → { endpoint, runtime, contractVersion }` by querying the catalog API and validating the v1 contract.

**Files:**
- Modify: `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts`
- Modify: `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`

- [ ] **Step 1: Write the failing AgentResolver tests**

Append to `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`:

```typescript
import { AgentInvocationError } from './kagentInvokeAction';

function buildEntity(overrides: Record<string, any> = {}) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'foo-agent',
      namespace: 'default',
      annotations: {
        'agents.platform.ai/version': 'v1',
        'agents.platform.ai/runtime': 'kagent',
        'agents.platform.ai/a2a-endpoint':
          'http://foo-agent.kagent.svc.cluster.local:8080',
        ...(overrides.annotations ?? {}),
      },
    },
    spec: {
      type: 'kagent-agent',
      ...(overrides.spec ?? {}),
    },
  };
}

function mockCatalogResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

describe('kagent:agent:invoke — AgentResolver', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('AGENT_NOT_FOUND when catalog returns 404', async () => {
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse({}, 404));

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgentInvocationError);
      expect(e.code).toBe('AGENT_NOT_FOUND');
      expect(e.message).toContain("'component:default/foo-agent'");
    }
  });

  it('INVALID_CONTRACT when version != v1', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        annotations: { 'agents.platform.ai/version': 'v99' },
      })),
    );

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toContain('Unsupported contract version: v99');
    }
  });

  it('INVALID_CONTRACT when a2a-endpoint annotation is missing', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        annotations: { 'agents.platform.ai/a2a-endpoint': undefined },
      })),
    );

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toMatch(/a2a-endpoint/);
    }
  });

  it('INVALID_CONTRACT when runtime is not kagent', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        annotations: { 'agents.platform.ai/runtime': 'crewai' },
      })),
    );

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toContain('Unsupported runtime: crewai');
    }
  });

  it('INVALID_CONTRACT when spec.type is not kagent-agent', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        spec: { type: 'service' },
      })),
    );

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toContain('not a kagent-agent');
    }
  });

  it('catalog call goes to the discovery-resolved base URL', async () => {
    const discovery = mockDiscovery('http://localhost:7007/api/catalog');
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
            // Second call (A2A) — not yet wired, will throw in Task 4. For now,
            // make the test stop after the catalog call by returning 500 so
            // the handler errors out before reaching A2A.
            .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as any);

    const action = createKagentInvokeAction({ discovery });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi', onError: 'continue' },
    });

    await action.handler(ctx);

    expect(discovery.getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'http://localhost:7007/api/catalog/entities/by-name/component/default/foo-agent',
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run the tests — they fail because `handler` throws "not implemented"**

```bash
yarn workspace backend test --testPathPattern=kagentInvokeAction
```

Expected: 6 new FAILs (the AgentResolver tests). The 5 input-validation tests still PASS.

- [ ] **Step 3: Implement `AgentResolver` in `kagentInvokeAction.ts`**

Replace the file contents with:

```typescript
/**
 * Custom Scaffolder Action: kagent:agent:invoke
 * ==============================================
 *
 * Synchronously invokes a kagent.dev Agent via the A2A protocol. Discovery
 * uses the agents.platform.ai/* v1 annotation contract on the auto-ingested
 * catalog entity. Designed to be called from any Backstage scaffolder
 * template — e.g., a "suggest skills" wizard step.
 *
 * IMPORTANT: agent responses are untrusted text. Templates that interpolate
 * the response into shell commands, file paths, or anything executable MUST
 * treat it as adversarial input.
 *
 * Companion spec: docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { DiscoveryService } from '@backstage/backend-plugin-api';

export class AgentInvocationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}

interface EndpointInfo {
  endpoint: string;
  runtime: string;
  contractVersion: string;
}

async function resolveAgent(
  discovery: DiscoveryService,
  name: string,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void },
): Promise<EndpointInfo> {
  const catalogBase = await discovery.getBaseUrl('catalog');
  const url = `${catalogBase}/entities/by-name/component/default/${encodeURIComponent(name)}`;

  logger.info(`kagent:agent:invoke — resolving '${name}'`);

  const response = await fetch(url);

  if (response.status === 404) {
    throw new AgentInvocationError(
      'AGENT_NOT_FOUND',
      `No catalog entity 'component:default/${name}'. Has the kagent Agent been ingested yet?`,
    );
  }
  if (!response.ok) {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Catalog returned HTTP ${response.status} for '${name}'.`,
    );
  }

  const entity: any = await response.json();
  const annotations: Record<string, string> = entity?.metadata?.annotations ?? {};

  if (entity?.spec?.type !== 'kagent-agent') {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' is not a kagent-agent (got type: ${entity?.spec?.type}).`,
    );
  }

  const version = annotations['agents.platform.ai/version'];
  if (version !== 'v1') {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Unsupported contract version: ${version}`,
    );
  }

  const runtime = annotations['agents.platform.ai/runtime'];
  if (runtime !== 'kagent') {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Unsupported runtime: ${runtime}`,
    );
  }

  const endpoint = annotations['agents.platform.ai/a2a-endpoint'];
  if (!endpoint) {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' is missing the agents.platform.ai/a2a-endpoint annotation.`,
    );
  }
  try {
    // Validate URL format.
    const parsed = new URL(endpoint);
    if (!parsed.hostname.endsWith('.svc.cluster.local')) {
      logger.warn(
        `kagent:agent:invoke — endpoint hostname '${parsed.hostname}' is not cluster-local; allowing for local-testing use case.`,
      );
    }
  } catch {
    throw new AgentInvocationError(
      'INVALID_CONTRACT',
      `Entity 'component:default/${name}' has an invalid a2a-endpoint URL: ${endpoint}`,
    );
  }

  logger.info(
    `kagent:agent:invoke — endpoint=${endpoint} runtime=${runtime}`,
  );

  return { endpoint, runtime, contractVersion: version };
}

export function createKagentInvokeAction(opts: { discovery: DiscoveryService }) {
  const { discovery } = opts;

  return createTemplateAction({
    id: 'kagent:agent:invoke',
    description:
      'Synchronously invokes a kagent.dev Agent via A2A. Returns its text response. ' +
      'WARNING: agent responses are untrusted — never interpolate into shell commands ' +
      'or file paths without sanitization.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/)
            .describe('Agent name as it appears in the catalog (matches the CRD metadata.name).'),
        prompt: z =>
          z
            .string()
            .min(1)
            .max(8000)
            .describe('User message to send to the agent.'),
        expectJson: z =>
          z
            .boolean()
            .optional()
            .describe('When true, parse the response as JSON.'),
        timeoutMs: z =>
          z
            .number()
            .int()
            .min(5000)
            .max(300000)
            .optional()
            .describe('Hard timeout for the A2A call (default 120000).'),
        onError: z =>
          z
            .enum(['fail', 'continue'])
            .optional()
            .describe('fail aborts the run; continue surfaces the error in outputs.'),
      },
      output: {
        response: z =>
          z
            .union([z.string(), z.unknown()])
            .describe('The agent text response, or parsed JSON when expectJson:true.'),
        agentName: z => z.string().describe('Echoed input.'),
        runtime: z => z.string().describe('From agents.platform.ai/runtime annotation.'),
        durationMs: z => z.number().int().describe('Wall-clock duration in ms.'),
        error: z =>
          z
            .union([z.null(), z.object({ code: z.string(), message: z.string() })])
            .describe('Populated only when onError:continue and the call failed.'),
      },
    },

    async handler(ctx) {
      const { name, prompt, onError } = ctx.input as {
        name: string;
        prompt: string;
        onError?: 'fail' | 'continue';
      };

      const startedAt = Date.now();

      try {
        const info = await resolveAgent(discovery, name, ctx.logger);

        // A2AClient call is wired in Task 4. For now, throw so the catalog
        // path is exercised end-to-end by the tests.
        void prompt;
        void info;
        throw new AgentInvocationError(
          'AGENT_ERROR',
          'A2A invocation not yet implemented (wired in Task 4).',
        );
      } catch (e: any) {
        const code = e instanceof AgentInvocationError ? e.code : 'AGENT_ERROR';
        const message = e instanceof Error ? e.message : String(e);

        if (onError === 'continue') {
          ctx.output('response', '');
          ctx.output('agentName', name);
          ctx.output('runtime', 'kagent');
          ctx.output('durationMs', Date.now() - startedAt);
          ctx.output('error', { code, message });
          ctx.logger.error(`kagent:agent:invoke — ${code}: ${message}`);
          return;
        }

        ctx.logger.error(`kagent:agent:invoke — ${code}: ${message}`);
        throw e;
      }
    },
  });
}
```

- [ ] **Step 4: Run the tests — AgentResolver tests pass**

```bash
yarn workspace backend test --testPathPattern=kagentInvokeAction
```

Expected: 11 PASS (5 input-validation + 6 AgentResolver). The handler still throws on the A2A step, but the resolver tests catch the typed error before checking it.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/modules/scaffolder/kagentInvokeAction.ts \
        packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts
git commit -m "feat(kagent): implement AgentResolver for kagent:agent:invoke

Resolves agent name → A2A endpoint by querying the catalog API and
validating the agents.platform.ai/* v1 contract. Returns typed errors
(AGENT_NOT_FOUND, INVALID_CONTRACT) for every failure mode. Covered by
6 new unit tests."
```

---

## Task 4: Implement `A2AClient` (A2A invocation)

Send the prompt to the resolved endpoint and parse the response. Uses Node 20 built-in `fetch` + `AbortController` for timeout, one retry on network-layer failure.

**Important:** If Task 1's probe revealed deltas from the spec's assumed wire format, use the **probed** request/response shape here, not the spec's assumed shape. The variable names in the code below assume the spec's shape — adjust the request body construction and response parsing to match the probe findings.

**Files:**
- Modify: `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts`
- Modify: `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`

- [ ] **Step 1: Write the failing A2AClient tests**

Append to `kagentInvokeAction.test.ts`:

```typescript
function mockA2ASuccess(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'test',
      result: { parts: [{ type: 'text', text }] },
    }),
  } as any;
}

function mockA2AJsonRpcError(code: number, message: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'test',
      error: { code, message },
    }),
  } as any;
}

function mockA2AHttp500() {
  return {
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => 'internal server error',
  } as any;
}

describe('kagent:agent:invoke — A2AClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path — concatenates text parts', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('Hello from the agent.'));

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    await action.handler(ctx);

    expect(ctx.output).toHaveBeenCalledWith('response', 'Hello from the agent.');
    expect(ctx.output).toHaveBeenCalledWith('agentName', 'foo-agent');
    expect(ctx.output).toHaveBeenCalledWith('runtime', 'kagent');
    expect(ctx.output).toHaveBeenCalledWith('error', null);
  });

  it('ENDPOINT_UNREACHABLE after retry exhaustion', async () => {
    const networkErr = new TypeError('fetch failed');
    (networkErr as any).cause = { code: 'ECONNREFUSED' };

    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr);

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('ENDPOINT_UNREACHABLE');
    }
    // 1 catalog + 2 A2A attempts (original + 1 retry)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('AGENT_ERROR on HTTP 500', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2AHttp500());

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('AGENT_ERROR');
      expect(e.message).toContain('500');
    }
    // No retry on HTTP errors
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('AGENT_ERROR on JSON-RPC error envelope', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2AJsonRpcError(-32603, 'internal'));

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('AGENT_ERROR');
      expect(e.message).toContain('-32603');
    }
  });

  it('INVOCATION_TIMEOUT when fetch never resolves', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockImplementationOnce((_url: string, init: any) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi', timeoutMs: 5000 },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVOCATION_TIMEOUT');
    }
  }, 10000);
});
```

- [ ] **Step 2: Run the tests — they fail because A2AClient is not implemented**

```bash
yarn workspace backend test --testPathPattern=kagentInvokeAction
```

Expected: 5 new FAILs. AgentResolver and input-validation tests still PASS.

- [ ] **Step 3: Implement `A2AClient` in `kagentInvokeAction.ts`**

Replace the `handler` function and add a new `invokeAgent` helper. Above the `createKagentInvokeAction` export, add:

```typescript
interface InvokeOptions {
  timeoutMs: number;
  stepId: string;
}

async function invokeAgent(
  endpoint: string,
  prompt: string,
  opts: InvokeOptions,
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void },
): Promise<string> {
  const body = {
    jsonrpc: '2.0',
    id: opts.stepId,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [{ type: 'text', text: prompt }],
      },
    },
  };

  const networkErrorCodes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  logger.info(
    `kagent:agent:invoke — POST ${endpoint} (prompt: ${prompt.length} chars)`,
  );

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new AgentInvocationError(
            'AGENT_ERROR',
            `Agent returned HTTP ${response.status}.`,
          );
        }

        const payload: any = await response.json();

        if (payload?.error) {
          throw new AgentInvocationError(
            'AGENT_ERROR',
            `Agent JSON-RPC error: ${payload.error.code} ${payload.error.message ?? ''}`.trim(),
          );
        }

        const parts: any[] = payload?.result?.parts ?? [];
        const text = parts
          .filter(p => p?.type === 'text')
          .map(p => String(p.text ?? ''))
          .join('');

        return text;
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          throw new AgentInvocationError(
            'INVOCATION_TIMEOUT',
            `Agent did not respond within ${opts.timeoutMs}ms.`,
          );
        }
        if (e instanceof AgentInvocationError) {
          throw e;
        }

        const code = e?.cause?.code ?? e?.code;
        const isNetworkError = networkErrorCodes.includes(code);

        if (!isNetworkError) {
          throw e;
        }

        if (attempt === 0) {
          logger.warn(
            `kagent:agent:invoke — retrying after network error: ${code}`,
          );
          await new Promise(r => setTimeout(r, 500));
          continue;
        }

        throw new AgentInvocationError(
          'ENDPOINT_UNREACHABLE',
          `Network error after retry: ${code}`,
        );
      }
    }

    // Loop body always throws on its second iteration; this line is
    // defensive in case future edits change the loop bound.
    throw new AgentInvocationError(
      'ENDPOINT_UNREACHABLE',
      'Retries exhausted',
    );
  } finally {
    clearTimeout(timer);
  }
}
```

Then replace the `handler` body in `createKagentInvokeAction` with:

```typescript
async handler(ctx) {
  const inputs = ctx.input as {
    name: string;
    prompt: string;
    expectJson?: boolean;
    timeoutMs?: number;
    onError?: 'fail' | 'continue';
  };
  const onError = inputs.onError ?? 'fail';
  const timeoutMs = inputs.timeoutMs ?? 120_000;
  const expectJson = inputs.expectJson ?? false;

  const startedAt = Date.now();

  try {
    const info = await resolveAgent(discovery, inputs.name, ctx.logger);
    const text = await invokeAgent(
      info.endpoint,
      inputs.prompt,
      { timeoutMs, stepId: ctx.task?.id ?? 'unknown' },
      ctx.logger,
    );

    let parsed: unknown = text;
    if (expectJson) {
      try {
        parsed = JSON.parse(text);
      } catch (e: any) {
        throw new AgentInvocationError(
          'INVALID_RESPONSE_JSON',
          `Expected JSON response but parse failed: ${e.message}`,
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    ctx.logger.info(
      `kagent:agent:invoke — response received in ${durationMs}ms (length: ${text.length} chars)`,
    );

    ctx.output('response', parsed);
    ctx.output('agentName', inputs.name);
    ctx.output('runtime', info.runtime);
    ctx.output('durationMs', durationMs);
    ctx.output('error', null);
  } catch (e: any) {
    const code = e instanceof AgentInvocationError ? e.code : 'AGENT_ERROR';
    const message = e instanceof Error ? e.message : String(e);

    if (onError === 'continue') {
      ctx.output('response', '');
      ctx.output('agentName', inputs.name);
      ctx.output('runtime', 'kagent');
      ctx.output('durationMs', Date.now() - startedAt);
      ctx.output('error', { code, message });
      ctx.logger.error(`kagent:agent:invoke — ${code}: ${message}`);
      return;
    }

    ctx.logger.error(`kagent:agent:invoke — ${code}: ${message}`);
    throw e;
  }
},
```

- [ ] **Step 4: Run the tests — A2AClient tests pass**

```bash
yarn workspace backend test --testPathPattern=kagentInvokeAction
```

Expected: 16 PASS (5 input + 6 resolver + 5 A2A).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/modules/scaffolder/kagentInvokeAction.ts \
        packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts
git commit -m "feat(kagent): implement A2AClient + handler wiring

Adds invokeAgent helper that POSTs the A2A message/send envelope to the
resolved endpoint with AbortController-based timeout and a single retry
on network-layer failures. Handler now ties resolver + invoker
together. Five new unit tests cover happy path, retry exhaustion, HTTP
500, JSON-RPC error envelopes, and timeout."
```

---

## Task 5: End-to-end orchestration tests (`expectJson`, `onError`, `durationMs`)

Cover the remaining handler behaviors: JSON parsing, `onError: continue`, and that `durationMs` is set.

**Files:**
- Modify: `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`

- [ ] **Step 1: Write the failing orchestration tests**

Append to `kagentInvokeAction.test.ts`:

```typescript
describe('kagent:agent:invoke — orchestration', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('expectJson: true — parses JSON response', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('{"foo": "bar", "n": 42}'));

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi', expectJson: true },
    });

    await action.handler(ctx);

    expect(ctx.output).toHaveBeenCalledWith('response', { foo: 'bar', n: 42 });
  });

  it('expectJson: true on bad JSON — INVALID_RESPONSE_JSON', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('not json'));

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi', expectJson: true },
    });

    try {
      await action.handler(ctx);
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_RESPONSE_JSON');
    }
  });

  it('onError: continue — returns error in output instead of throwing', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2AHttp500());

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi', onError: 'continue' },
    });

    await action.handler(ctx);

    expect(ctx.output).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ code: 'AGENT_ERROR' }),
    );
    expect(ctx.output).toHaveBeenCalledWith('response', '');
  });

  it('durationMs is set to a non-negative number', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('done'));

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    await action.handler(ctx);

    const durationCall = (ctx.output as jest.Mock).mock.calls.find(
      ([k]) => k === 'durationMs',
    );
    expect(durationCall).toBeDefined();
    expect(durationCall![1]).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the tests — `expectJson` and `onError` tests pass already**

```bash
yarn workspace backend test --testPathPattern=kagentInvokeAction
```

Expected: 20 PASS. The handler logic written in Task 4 already covers these cases — Task 5 is purely about *test coverage*, not new production code.

If any tests fail here, the implementation in Task 4 had a gap. Fix the implementation, not the test.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts
git commit -m "test(kagent): cover expectJson, onError, durationMs for invoke action

Locks in the orchestration-layer behaviors with dedicated tests so
future refactors can't regress them silently."
```

---

## Task 6: Register `kagent:agent:invoke` with the backend module

Wire the new action into the scaffolder backend module so it shows up in the actions list at runtime.

**Files:**
- Modify: `packages/backend/src/modules/scaffolder/index.ts`

- [ ] **Step 1: Read the current index.ts**

```bash
cat packages/backend/src/modules/scaffolder/index.ts
```

Confirm the current structure: a `createBackendModule` with `deps: { scaffolderActions: scaffolderActionsExtensionPoint }` and an `init` that calls `addActions(...)`.

- [ ] **Step 2: Modify index.ts to inject discovery and register the new action**

Replace the file contents with:

```typescript
/**
 * Custom Scaffolder Actions Module
 * ==================================
 *
 * This module registers custom scaffolder actions with the Backstage backend.
 * It uses the New Backend System's extension point mechanism to add actions
 * to the scaffolder plugin.
 *
 * REGISTERED ACTIONS:
 * - publish:file — Writes template output to local filesystem (for testing)
 * - aws:ecr:create — Creates ECR repositories
 * - aws:ecr:build-push — Builds Docker images and pushes them to ECR (legacy)
 * - vault:setup — Creates Vault policy, K8s auth role, and placeholder secrets
 * - crossplane:teardown:open-decommission-pr — Opens a teardown PR for a v1.x IDP app
 * - kagent:agent:validate-name — Fails the wizard on kagent agent name collisions
 * - kagent:agent:open-decommission-pr — Opens a teardown PR for an IDP-managed kagent Agent
 * - kagent:agent:invoke — Synchronously calls a kagent.dev Agent via the A2A protocol
 */

import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createPublishFileAction } from './publishFileAction';
import { createEcrCreateAction } from './ecrCreateAction';
import { createEcrBuildPushAction } from './ecrBuildPushAction';
import { createVaultSetupAction } from './vaultSetupAction';
import { createDecommissionPullRequestAction } from './decommissionPullRequestAction';
import { createKagentValidateNameAction } from './kagentValidateNameAction';
import { createKagentDecommissionAction } from './kagentDecommissionAction';
import { createKagentInvokeAction } from './kagentInvokeAction';

const scaffolderCustomActionsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'custom-actions',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolderActions: scaffolderActionsExtensionPoint,
        // kagent:agent:invoke uses discovery to find the local catalog API.
        discovery: coreServices.discovery,
      },
      async init({ scaffolderActions, discovery }) {
        scaffolderActions.addActions(
          createPublishFileAction(),
          createEcrCreateAction(),
          createEcrBuildPushAction(),
          createVaultSetupAction(),
          createDecommissionPullRequestAction(),
          createKagentValidateNameAction(),
          createKagentDecommissionAction(),
          createKagentInvokeAction({ discovery }),
        );
      },
    });
  },
});

export default scaffolderCustomActionsModule;
```

- [ ] **Step 3: Run the full backend test suite to ensure nothing else broke**

```bash
yarn workspace backend test
```

Expected: ALL PASS (existing tests + the 20 new ones).

- [ ] **Step 4: Run typecheck and lint on the backend**

```bash
yarn workspace backend lint && yarn workspace backend tsc --noEmit
```

Expected: no errors. If lint fails on the modified files, fix the formatting and re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/modules/scaffolder/index.ts
git commit -m "feat(backend): register kagent:agent:invoke with scaffolder module

Injects coreServices.discovery into the deps block so the new action can
resolve the local catalog API URL at runtime. Existing seven actions
keep working unchanged."
```

---

## Task 7: Layer 2 manual validation against the deployed cluster

The spec's Layer 2 validation: prove the action works against a real kagent agent in the live cluster. **The user handles the Docker image build/push and ArgoCD sync.** This task is the manual checklist they follow once the new image is live.

This task does NOT modify code. It produces a brief paragraph appended to this plan recording the validation result.

**Files:**
- Modify: `docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md` (append "Layer 2 Validation Result")

- [ ] **Step 1: Wait for the user to confirm the new Backstage image is deployed**

The user owns this. Implementer should pause here until the user confirms.

- [ ] **Step 2: Create a throwaway test template that calls the action**

Add a temporary file `examples/templates/_test-kagent-invoke/template.yaml` (gitignored after Task 7 — DO NOT commit it):

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: _test-kagent-invoke
  title: '[INTERNAL] Test kagent:agent:invoke'
  description: Throwaway template for Layer 2 validation of the invoke action.
spec:
  owner: group:platform-engineering
  type: service
  parameters:
    - title: Test
      required: [agentName, prompt]
      properties:
        agentName:
          title: Agent to call
          type: string
          default: dnd-agent
        prompt:
          title: Prompt
          type: string
          default: Say hello in one short sentence.
          ui:widget: textarea
  steps:
    - id: call-agent
      name: Call kagent agent
      action: kagent:agent:invoke
      input:
        name: ${{ parameters.agentName }}
        prompt: ${{ parameters.prompt }}
        timeoutMs: 60000
        onError: continue
  output:
    text:
      - title: Response
        content: |
          Agent: ${{ steps['call-agent'].output.agentName }}
          Runtime: ${{ steps['call-agent'].output.runtime }}
          Duration: ${{ steps['call-agent'].output.durationMs }}ms
          Error: ${{ steps['call-agent'].output.error }}

          Response:
          ${{ steps['call-agent'].output.response }}
```

Register it temporarily in `app-config.yaml` under `catalog.locations` if not auto-discovered, or import it from the Backstage UI via "Register existing component".

- [ ] **Step 3: Run the template from the Backstage UI**

1. Navigate to `<backstage-url>/create/templates/default/_test-kagent-invoke`
2. Click "Choose"
3. Accept the defaults (or pick a different agent name)
4. Click "Create"
5. Observe the run

- [ ] **Step 4: Record the result in this plan**

Append to this file under a new `## Layer 2 Validation Result (YYYY-MM-DD)` section:

1. **Did the action complete?** (yes/no, with the wall-clock duration from `durationMs`)
2. **What was the agent's response?** (first 200 chars)
3. **Did the resolver log line show the correct endpoint?** (paste it from the scaffolder run log)
4. **Did the wire format pinned in Task 1 work as expected?** (yes/no — if no, capture the exception code and message)
5. **Any unexpected behaviors?** (free-form)

- [ ] **Step 5: Delete the throwaway test template**

```bash
rm -rf examples/templates/_test-kagent-invoke/
```

If you registered it in `app-config.yaml`, remove the entry too.

- [ ] **Step 6: Commit the validation findings**

```bash
git add docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md
git commit -m "docs(plan): record Layer 2 validation result for kagent:agent:invoke

Live test against <agent name> in the cluster: <success/failure
summary>. <Any deltas from the spec captured.>"
```

---

## Task 8: Operator-facing documentation

Public usage guide for the new action, modeled on the existing `agent-annotation-contract-v1.md` style.

**Files:**
- Create: `docs/guides/scaffolder-action-kagent-invoke.md`

- [ ] **Step 1: Write the docs guide**

Create `docs/guides/scaffolder-action-kagent-invoke.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/guides/scaffolder-action-kagent-invoke.md
git commit -m "docs(kagent): add operator guide for kagent:agent:invoke action

Covers when to use, the input/output contract, the full error
taxonomy, a 'suggest skills' worked example, security notes, and a
troubleshooting table mapping each error code to a likely cause and
fix."
```

---

## Final checklist

- [ ] All 8 tasks committed.
- [ ] `yarn workspace backend test` passes with 20 new tests in `kagentInvokeAction.test.ts`.
- [ ] `yarn workspace backend lint` and `tsc --noEmit` clean.
- [ ] The plan file contains both the A2A probe findings (Task 1) and the Layer 2 validation result (Task 7).
- [ ] No `examples/templates/_test-kagent-invoke/` directory left in the repo.
- [ ] PR description references this plan and the design spec.
