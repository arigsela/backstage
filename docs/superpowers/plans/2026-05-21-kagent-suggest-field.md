# `KagentSuggest` Scaffolder Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Backstage custom scaffolder field (`KagentSuggest`) that interactively calls a kagent agent during wizard form-fill, lets users add suggestions item-by-item to a target form array, and wire it into the kagent-agent template's Skills page.

**Architecture:** Three units. (1) Extract `kagent-shared` library from `kagentInvokeAction.ts` so the resolver + A2A invoker have one home. (2) New `kagent-suggest` backend module exposes `POST /api/kagent-suggest/invoke` — a thin HTTP wrapper over the shared library. (3) New `KagentSuggest` React field calls that endpoint and renders an editable preview list with per-item Add buttons.

**Tech Stack:** TypeScript, Backstage New Backend System, React + Material UI 4, `@backstage/plugin-scaffolder-react` for field extensions, Jest + `@testing-library/react` for frontend tests, Node 20 built-in `fetch` / `AbortController`. No new runtime deps (frontend field extension package is already a transitive dep — we add it explicitly).

**Spec reference:** `docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md`.

---

## Layer 2 Validation Result (2026-05-21)

The KagentSuggest field works end-to-end against a real `skill-suggester`
agent in the deployed cluster.

| Field | Value |
| --- | --- |
| Agent | `skill-suggester` |
| Prompt description | `"test agent for skill suggester"` |
| Response | 3 editable suggestion rows rendered with id/name/description fields and Add buttons |
| First suggestion | `skill-suggester-validation` — Skill Suggester Validation — "Validates and tests the skill suggestion output format and quality from the skill suggester agent." |
| Round-trip latency | ~5-10s (visual estimate; no instrumentation captured wall-clock) |
| Add button | Verified: clicking Add appended the (potentially-edited) item to the Skills array |

### Three gotchas discovered during validation (each fixed; commits logged below)

1. **Frontend not building.** `scripts/build-and-push.sh` only runs `yarn build:backend` — the frontend (`packages/app`) was not rebuilt, so production was serving stale JS. Workaround: `yarn workspace app build && ./scripts/build-and-push.sh`. Permanent fix should be a script change to chain `yarn build:all`.
2. **Backend body parser not applied.** `req.body` arrived undefined at the route handler despite a correct client request — Backstage's global JSON parser didn't reach our plugin-scoped router. Fixed in commit `0c97027` by adding `router.use(express.json())` explicitly.
3. **LLM responses not pure JSON.** The agent wrapped its output in markdown code fences (or added prose) even though the system message said "only JSON". Fixed in commit `6cb7f8e` by adding a tolerant JSON parser that strips ` ```json ` fences and extracts arrays/objects from prose-surrounded text.

The two backend gotchas have permanent fixes in the codebase. The build-script
gotcha will be addressed in a follow-up commit.

---

## Post-Refactor Verification (2026-05-22)

After the Layer 2 result above surfaced a fourth gotcha — the
`formContext.onChange is not a function` runtime error — the field was
refactored (spec amendment 2026-05-21, commit `bf66221`) so that the
field owns its own array value via rjsf's standard `props.onChange`.

Verified end-to-end via Playwright against the deployed v1.2.0 image
on 2026-05-22.

| Step | Result |
| --- | --- |
| Field renders on Skills page | ✅ `[Suggest skills]` button + `0 items added` summary |
| First Suggest click (description: "An agent that helps customers troubleshoot login and account access issues.") | ✅ 3 contextually-relevant suggestions returned within ~10s |
| Click Add on first suggestion (`account-verification`) | ✅ Counter `0 items added` → `1 item added`; row vanishes from preview; 2 remain |
| Second Suggest click (with 1 item already added) | ✅ Returns 3 NEW suggestions; `account-verification` not repeated — anti-dup confirmed |
| Skills → Resources → Publish → Review navigation | ✅ No schema validation errors after a fresh page load |
| Review page | ✅ Added skill appears as `{id, name, description}` object, ready for submit |

Test agent suggestions (from `skill-suggester`):

```
Round 1 (description-based):
  - account-verification — Account Verification
  - password-reset-assistance — Password Reset Assistance
  - access-restoration — Access Restoration

Round 2 (after adding account-verification; "do NOT duplicate" suffix attached):
  - 3 NEW suggestions, none matching account-verification
```

### One known artifact

When navigating back-and-forth through the wizard in a browser tab
that previously loaded the OLD field shape (`type: string` +
`title: "AI assist (optional)"`), rjsf surfaces a stale validation
error: `'AI assist (optional)' must be string`. A hard refresh
(Cmd-Shift-R) clears it permanently. Fresh browser sessions don't see
it.

### What still works

All 48 unit tests on the branch remain green (36 backend + 12 frontend).
The component refactor traded 11 minor test updates for 5 new
behaviors (count summary, anti-dup, vanishing rows, no formContext mock,
singular/plural copy) without losing coverage.

---

## File Structure

| Path | Action | Purpose |
| --- | --- | --- |
| `packages/backend/src/modules/kagent-shared/errors.ts` | Create | `AgentInvocationError` class. |
| `packages/backend/src/modules/kagent-shared/resolver.ts` | Create | `resolveAgent` + `EndpointInfo`. |
| `packages/backend/src/modules/kagent-shared/invoker.ts` | Create | `invokeAgent` + `InvokeOptions`. |
| `packages/backend/src/modules/kagent-shared/validation.ts` | Create | `validateInvokeInput` + `ValidatedInput`. |
| `packages/backend/src/modules/kagent-shared/index.ts` | Create | Re-exports of all of the above. |
| `packages/backend/src/modules/kagent-shared/resolver.test.ts` | Create | 6 resolver tests (migrated). |
| `packages/backend/src/modules/kagent-shared/invoker.test.ts` | Create | 6 A2A invoker tests (migrated). |
| `packages/backend/src/modules/kagent-shared/validation.test.ts` | Create | 5 input validation tests (migrated). |
| `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts` | Modify | Becomes a thin orchestrator that imports from kagent-shared. |
| `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts` | Modify | Reduced to 4 orchestration tests. |
| `packages/backend/src/modules/kagent-suggest/router.ts` | Create | HTTP route handler `POST /invoke`. |
| `packages/backend/src/modules/kagent-suggest/router.test.ts` | Create | 8 route tests. |
| `packages/backend/src/modules/kagent-suggest/index.ts` | Create | Backend module registration. |
| `packages/backend/src/index.ts` | Modify | Register the new `kagent-suggest` module. |
| `packages/app/package.json` | Modify | Add `@backstage/plugin-scaffolder-react` dependency. |
| `packages/app/src/scaffolder/KagentSuggestField/KagentSuggestField.tsx` | Create | React component. |
| `packages/app/src/scaffolder/KagentSuggestField/extension.tsx` | Create | `createScaffolderFieldExtension` wrapper. |
| `packages/app/src/scaffolder/KagentSuggestField/index.ts` | Create | Re-exports the extension. |
| `packages/app/src/scaffolder/KagentSuggestField/KagentSuggestField.test.tsx` | Create | 12 frontend tests. |
| `packages/app/src/App.tsx` | Modify | Wire `<KagentSuggestFieldExtension/>` into `<ScaffolderPage>`. |
| `examples/templates/kagent-agent/template.yaml` | Modify | Add `ui:field: KagentSuggest` block to Skills page. |
| `docs/superpowers/plans/2026-05-21-kagent-suggest-field.md` | Modify (Task 5) | Append Layer 2 validation result. |

---

## Task 1: Extract `kagent-shared` library

Pure refactor. Move the resolver, invoker, and input validation out of `kagentInvokeAction.ts` into a new shared library. Action becomes a thin orchestrator. **Behavior must not change.** All 21 existing tests must continue to pass — most just move to new files.

**Files:**
- Create: 5 files under `packages/backend/src/modules/kagent-shared/`
- Modify: `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts`
- Modify: `packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts`

- [ ] **Step 1: Create `kagent-shared/errors.ts`**

```typescript
/**
 * Typed error class for all kagent invocation failures. The `code` field is
 * the contract between the resolver/invoker and the consumers (the scaffolder
 * action and the kagent-suggest HTTP route).
 */
export class AgentInvocationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}
```

- [ ] **Step 2: Create `kagent-shared/resolver.ts`**

```typescript
import type { DiscoveryService } from '@backstage/backend-plugin-api';
import { AgentInvocationError } from './errors';

export interface EndpointInfo {
  endpoint: string;
  runtime: string;
  contractVersion: string;
}

/**
 * Resolves a kagent agent name to its A2A endpoint by querying the local
 * catalog API. Validates the agents.platform.ai/* v1 annotation contract.
 *
 * Throws AgentInvocationError on missing or non-conformant entities.
 */
export async function resolveAgent(
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
```

- [ ] **Step 3: Create `kagent-shared/invoker.ts`**

```typescript
import { randomUUID } from 'crypto';
import { AgentInvocationError } from './errors';

export interface InvokeOptions {
  timeoutMs: number;
  stepId: string;
}

/**
 * Invoke a kagent agent via the A2A protocol. Wire format pinned by the live
 * probe (see docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md):
 *   1. params.message.messageId is REQUIRED (agent returns -32602 otherwise)
 *   2. Response text lives at .result.artifacts[].parts[].text
 *   3. Response parts use kind:"text" (input uses type:"text")
 */
export async function invokeAgent(
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
        messageId: randomUUID(),
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

        const artifacts: any[] = payload?.result?.artifacts ?? [];
        const text = artifacts
          .flatMap(a => (Array.isArray(a?.parts) ? a.parts : []))
          .filter(p => p?.kind === 'text')
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

    throw new AgentInvocationError(
      'ENDPOINT_UNREACHABLE',
      'Retries exhausted',
    );
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Create `kagent-shared/validation.ts`**

```typescript
export interface ValidatedInput {
  name: string;
  prompt: string;
  expectJson?: boolean;
  timeoutMs?: number;
  onError?: 'fail' | 'continue';
}

/**
 * Runtime input validation. Mirrors the contract the action's zod schema
 * advertises, but enforces at call time (zod in createTemplateAction only
 * drives the wizard UI form generator — it doesn't validate at handler call).
 *
 * The `maxTimeoutMs` option lets consumers cap the timeout differently —
 * the scaffolder action allows up to 300_000ms, but the HTTP route caps
 * at 120_000ms because users are waiting interactively.
 */
export function validateInvokeInput(
  raw: unknown,
  opts: { maxTimeoutMs?: number } = {},
): ValidatedInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 300_000;

  if (
    typeof r.name !== 'string' ||
    !/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/.test(r.name)
  ) {
    throw new Error(
      `kagent:agent:invoke: invalid agent name '${String(r.name)}'. Must match ^[a-z][a-z0-9-]{2,38}[a-z0-9]$.`,
    );
  }
  if (
    typeof r.prompt !== 'string' ||
    r.prompt.length < 1 ||
    r.prompt.length > 8000
  ) {
    throw new Error(
      `kagent:agent:invoke: invalid prompt length (${
        typeof r.prompt === 'string' ? r.prompt.length : 'not a string'
      }). Must be 1..8000 chars.`,
    );
  }
  if (r.timeoutMs !== undefined) {
    if (
      typeof r.timeoutMs !== 'number' ||
      !Number.isInteger(r.timeoutMs) ||
      r.timeoutMs < 5000 ||
      r.timeoutMs > maxTimeoutMs
    ) {
      throw new Error(
        `kagent:agent:invoke: invalid timeoutMs ${String(r.timeoutMs)}. Must be an integer in 5000..${maxTimeoutMs}.`,
      );
    }
  }
  if (
    r.onError !== undefined &&
    r.onError !== 'fail' &&
    r.onError !== 'continue'
  ) {
    throw new Error(
      `kagent:agent:invoke: invalid onError '${String(r.onError)}'. Must be 'fail' or 'continue'.`,
    );
  }
  if (r.expectJson !== undefined && typeof r.expectJson !== 'boolean') {
    throw new Error(
      `kagent:agent:invoke: invalid expectJson type (${typeof r.expectJson}). Must be boolean.`,
    );
  }

  return {
    name: r.name,
    prompt: r.prompt,
    expectJson: r.expectJson as boolean | undefined,
    timeoutMs: r.timeoutMs as number | undefined,
    onError: r.onError as 'fail' | 'continue' | undefined,
  };
}
```

- [ ] **Step 5: Create `kagent-shared/index.ts`** (re-exports)

```typescript
export { AgentInvocationError } from './errors';
export { resolveAgent } from './resolver';
export type { EndpointInfo } from './resolver';
export { invokeAgent } from './invoker';
export type { InvokeOptions } from './invoker';
export { validateInvokeInput } from './validation';
export type { ValidatedInput } from './validation';
```

- [ ] **Step 6: Create `kagent-shared/resolver.test.ts`** (migrate the 6 resolver tests from `kagentInvokeAction.test.ts`)

```typescript
/**
 * Unit tests for AgentResolver — migrated from kagentInvokeAction.test.ts.
 * Tests resolver in isolation; no scaffolder context needed.
 */
import { AgentInvocationError } from './errors';
import { resolveAgent } from './resolver';

function mockDiscovery(catalogBase = 'http://localhost:7007/api/catalog') {
  return {
    getBaseUrl: jest.fn().mockResolvedValue(catalogBase),
    getExternalBaseUrl: jest.fn().mockResolvedValue(catalogBase),
  } as any;
}

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

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

describe('resolveAgent', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('AGENT_NOT_FOUND when catalog returns 404', async () => {
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse({}, 404));

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
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

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
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

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
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

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
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

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toContain('not a kagent-agent');
    }
  });

  it('returns endpoint info on a valid v1 entity', async () => {
    const discovery = mockDiscovery('http://localhost:7007/api/catalog');
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse(buildEntity()));

    const info = await resolveAgent(discovery, 'foo-agent', mockLogger());

    expect(info).toEqual({
      endpoint: 'http://foo-agent.kagent.svc.cluster.local:8080',
      runtime: 'kagent',
      contractVersion: 'v1',
    });
    expect(discovery.getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://localhost:7007/api/catalog/entities/by-name/component/default/foo-agent',
    );
  });
});
```

- [ ] **Step 7: Create `kagent-shared/invoker.test.ts`** (migrate the 6 A2A tests)

```typescript
/**
 * Unit tests for A2AClient — migrated from kagentInvokeAction.test.ts.
 */
import { AgentInvocationError } from './errors';
import { invokeAgent } from './invoker';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

function mockA2ASuccess(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'test',
      result: {
        kind: 'task',
        artifacts: [
          {
            artifactId: 'art-1',
            parts: [{ kind: 'text', text }],
          },
        ],
        status: { state: 'completed' },
      },
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

const ENDPOINT = 'http://foo-agent.kagent.svc.cluster.local:8080';

describe('invokeAgent', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path — concatenates text parts from artifacts', async () => {
    fetchSpy.mockResolvedValueOnce(mockA2ASuccess('Hello from the agent.'));

    const text = await invokeAgent(
      ENDPOINT,
      'hi',
      { timeoutMs: 60000, stepId: 'test' },
      mockLogger(),
    );

    expect(text).toBe('Hello from the agent.');
  });

  it('request body includes messageId (required by kagent A2A)', async () => {
    fetchSpy.mockResolvedValueOnce(mockA2ASuccess('ok'));

    await invokeAgent(
      ENDPOINT,
      'hi',
      { timeoutMs: 60000, stepId: 'test-id' },
      mockLogger(),
    );

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call[1] as any).body);
    expect(body.method).toBe('message/send');
    expect(body.id).toBe('test-id');
    expect(body.params.message.messageId).toEqual(expect.any(String));
    expect(body.params.message.messageId.length).toBeGreaterThan(0);
  });

  it('ENDPOINT_UNREACHABLE after retry exhaustion', async () => {
    const networkErr = new TypeError('fetch failed');
    (networkErr as any).cause = { code: 'ECONNREFUSED' };

    fetchSpy
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr);

    try {
      await invokeAgent(
        ENDPOINT,
        'hi',
        { timeoutMs: 60000, stepId: 'test' },
        mockLogger(),
      );
      fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgentInvocationError);
      expect(e.code).toBe('ENDPOINT_UNREACHABLE');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('AGENT_ERROR on HTTP 500', async () => {
    fetchSpy.mockResolvedValueOnce(mockA2AHttp500());

    try {
      await invokeAgent(
        ENDPOINT,
        'hi',
        { timeoutMs: 60000, stepId: 'test' },
        mockLogger(),
      );
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('AGENT_ERROR');
      expect(e.message).toContain('500');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('AGENT_ERROR on JSON-RPC error envelope', async () => {
    fetchSpy.mockResolvedValueOnce(mockA2AJsonRpcError(-32603, 'internal'));

    try {
      await invokeAgent(
        ENDPOINT,
        'hi',
        { timeoutMs: 60000, stepId: 'test' },
        mockLogger(),
      );
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('AGENT_ERROR');
      expect(e.message).toContain('-32603');
    }
  });

  it('INVOCATION_TIMEOUT when fetch never resolves', async () => {
    fetchSpy.mockImplementationOnce((_url: string, init: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    try {
      await invokeAgent(
        ENDPOINT,
        'hi',
        { timeoutMs: 5000, stepId: 'test' },
        mockLogger(),
      );
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVOCATION_TIMEOUT');
    }
  }, 10000);
});
```

- [ ] **Step 8: Create `kagent-shared/validation.test.ts`** (migrate the 5 input validation tests)

```typescript
import { validateInvokeInput } from './validation';

describe('validateInvokeInput', () => {
  it('rejects empty prompt', () => {
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: '' }),
    ).toThrow(/invalid prompt length/);
  });

  it('rejects prompt over 8000 chars', () => {
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: 'x'.repeat(8001) }),
    ).toThrow(/invalid prompt length/);
  });

  it('rejects invalid agent name', () => {
    expect(() =>
      validateInvokeInput({ name: 'INVALID_NAME', prompt: 'hello' }),
    ).toThrow(/invalid agent name/);
  });

  it('rejects timeoutMs below 5000', () => {
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: 'hello', timeoutMs: 1000 }),
    ).toThrow(/invalid timeoutMs/);
  });

  it('rejects timeoutMs above maxTimeoutMs', () => {
    // Default cap is 300_000; passing 999_999 must fail.
    expect(() =>
      validateInvokeInput({ name: 'foo-agent', prompt: 'hello', timeoutMs: 999999 }),
    ).toThrow(/invalid timeoutMs/);
    // Lower cap of 120_000: 250_000 must also fail under the route's cap.
    expect(() =>
      validateInvokeInput(
        { name: 'foo-agent', prompt: 'hello', timeoutMs: 250000 },
        { maxTimeoutMs: 120000 },
      ),
    ).toThrow(/invalid timeoutMs/);
  });
});
```

- [ ] **Step 9: Refactor `kagentInvokeAction.ts` to use kagent-shared**

Replace the file contents with this thin orchestrator:

```typescript
/**
 * Custom Scaffolder Action: kagent:agent:invoke
 * ==============================================
 *
 * Synchronously invokes a kagent.dev Agent via the A2A protocol. Now a thin
 * orchestrator over the kagent-shared library (resolver + invoker + input
 * validation). The shared library is the single source of truth for the
 * wire format and contract validation.
 *
 * IMPORTANT: agent responses are untrusted text. Templates that interpolate
 * the response into shell commands, file paths, or anything executable MUST
 * treat it as adversarial input.
 *
 * Companion spec: docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { DiscoveryService } from '@backstage/backend-plugin-api';
import {
  AgentInvocationError,
  invokeAgent,
  resolveAgent,
  validateInvokeInput,
} from '../kagent-shared';

// Re-export so any existing imports of AgentInvocationError from this module
// continue to work.
export { AgentInvocationError };

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
      const inputs = validateInvokeInput(ctx.input);
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
  });
}
```

- [ ] **Step 10: Reduce `kagentInvokeAction.test.ts` to 4 orchestration-only tests**

Replace the file contents entirely (the 17 migrated tests are now in kagent-shared/*.test.ts):

```typescript
/**
 * Orchestration-layer tests for kagent:agent:invoke. Resolver, invoker, and
 * input-validation tests live in kagent-shared/*.test.ts — this file covers
 * what the action does on TOP of those primitives:
 *   - expectJson parsing (and INVALID_RESPONSE_JSON on bad JSON)
 *   - onError:continue (error in output instead of throw)
 *   - durationMs emission
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

function buildEntity() {
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
      },
    },
    spec: { type: 'kagent-agent' },
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

function mockA2ASuccess(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'test',
      result: {
        kind: 'task',
        artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text }] }],
        status: { state: 'completed' },
      },
    }),
  } as any;
}

function mockA2AHttp500() {
  return {
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => 'err',
  } as any;
}

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

- [ ] **Step 11: Run the full backend test suite — all tests pass**

Run from repo root:

```bash
node packages/backend/node_modules/@backstage/cli/bin/backstage-cli package test --testPathPatterns='kagentInvokeAction|kagent-shared' --watchAll=false
```

Expected output: `Tests: 21 passed, 21 total` (6 resolver + 6 invoker + 5 validation + 4 orchestration).

If any test fails, the refactor introduced a behavior change. Fix the implementation in kagent-shared (not the test) and re-run.

- [ ] **Step 12: Commit**

```bash
git add packages/backend/src/modules/kagent-shared/ \
        packages/backend/src/modules/scaffolder/kagentInvokeAction.ts \
        packages/backend/src/modules/scaffolder/kagentInvokeAction.test.ts
git commit -m "refactor(kagent): extract kagent-shared library

Splits kagentInvokeAction.ts into five focused files under
packages/backend/src/modules/kagent-shared/: errors, resolver, invoker,
validation, and an index re-export. The scaffolder action becomes a
thin orchestrator that imports from the shared library.

17 of the existing 21 tests move alongside their unit under test:
- resolver.test.ts: 6 catalog-validation tests
- invoker.test.ts: 6 A2A invocation tests
- validation.test.ts: 5 input-validation tests

The remaining 4 orchestration tests (expectJson parse, onError:continue,
durationMs) stay with the action.

No behavior change — the existing kagent:agent:invoke wire format,
error taxonomy, and output shape are preserved exactly. Prepares for
the kagent-suggest backend route that will be the second consumer."
```

---

## Task 2: Add `kagent-suggest` backend module

Expose `POST /api/kagent-suggest/invoke` so the frontend field can call agents. Thin HTTP wrapper over the shared library.

**Files:**
- Create: `packages/backend/src/modules/kagent-suggest/router.ts`
- Create: `packages/backend/src/modules/kagent-suggest/router.test.ts`
- Create: `packages/backend/src/modules/kagent-suggest/index.ts`
- Modify: `packages/backend/src/index.ts`

- [ ] **Step 1: Write the failing route tests**

Create `packages/backend/src/modules/kagent-suggest/router.test.ts`:

```typescript
/**
 * Unit tests for the kagent-suggest HTTP route.
 *
 * Spins up a minimal Express app with the router mounted, fires requests
 * through supertest, asserts on the JSON response.
 */
import express from 'express';
import request from 'supertest';

import { createRouter } from './router';

function mockDiscovery(catalogBase = 'http://localhost:7007/api/catalog') {
  return {
    getBaseUrl: jest.fn().mockResolvedValue(catalogBase),
    getExternalBaseUrl: jest.fn().mockResolvedValue(catalogBase),
  } as any;
}

function buildEntity() {
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
      },
    },
    spec: { type: 'kagent-agent' },
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

function mockA2ASuccess(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'test',
      result: {
        kind: 'task',
        artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text }] }],
        status: { state: 'completed' },
      },
    }),
  } as any;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const router = await createRouter({
    discovery: mockDiscovery(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: function () { return this; } } as any,
  });
  app.use('/api/kagent-suggest', router);
  return app;
}

describe('kagent-suggest router', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path — returns ok:true with response, agentName, runtime, durationMs', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('Hello.'));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.response).toBe('Hello.');
    expect(res.body.agentName).toBe('foo-agent');
    expect(res.body.runtime).toBe('kagent');
    expect(typeof res.body.durationMs).toBe('number');
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('expectJson: true — parses JSON response', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('[{"id":"a","name":"A","description":"x"}]'));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi', expectJson: true });

    expect(res.body.ok).toBe(true);
    expect(res.body.response).toEqual([
      { id: 'a', name: 'A', description: 'x' },
    ]);
  });

  it('schema rejection — missing agentName returns BAD_INPUT', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('BAD_INPUT');
  });

  it('schema rejection — prompt over 8000 chars returns BAD_INPUT', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'x'.repeat(8001) });

    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('BAD_INPUT');
  });

  it('schema rejection — timeoutMs over 120000 returns BAD_INPUT', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi', timeoutMs: 250000 });

    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('BAD_INPUT');
  });

  it('AGENT_NOT_FOUND surfaces from resolver', async () => {
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse({}, 404));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'missing-agent', prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
    expect(res.body.message).toContain("'component:default/missing-agent'");
  });

  it('INVALID_RESPONSE_JSON when expectJson is true and agent returns non-JSON', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('not json'));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi', expectJson: true });

    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INVALID_RESPONSE_JSON');
  });

  it('OPTIONS preflight — returns 204', async () => {
    const app = await buildApp();
    const res = await request(app).options('/api/kagent-suggest/invoke');
    // 204 from cors() default, or 404 if not configured. We accept either to
    // tolerate Backstage's default CORS handling at the rootHttpRouter layer.
    expect([200, 204, 404]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run the tests — they fail because the router doesn't exist**

```bash
node packages/backend/node_modules/@backstage/cli/bin/backstage-cli package test --testPathPatterns=kagent-suggest --watchAll=false
```

Expected: FAIL with `Cannot find module './router'`.

- [ ] **Step 3: Verify `supertest` is available, install if not**

```bash
cd packages/backend && yarn list supertest 2>&1 | head -5; cd ../..
```

If supertest isn't listed: `yarn workspace backend add --dev supertest @types/supertest`.

- [ ] **Step 4: Create `kagent-suggest/router.ts`**

```typescript
/**
 * HTTP route handler for the kagent-suggest backend module.
 *
 * Exposes:  POST /invoke
 *
 * Mounted at /api/kagent-suggest in the root HTTP router. Thin wrapper over
 * the kagent-shared library — validates input (with a 120s timeout cap),
 * resolves the agent via the catalog, invokes via A2A, returns the response
 * as JSON. Always HTTP 200 (or 401 from auth middleware); failures are
 * communicated via {ok: false, code, message} in the body so the frontend
 * field can render them inline.
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 */
import { Router } from 'express';
import type { DiscoveryService, LoggerService } from '@backstage/backend-plugin-api';
import {
  AgentInvocationError,
  invokeAgent,
  resolveAgent,
  validateInvokeInput,
} from '../kagent-shared';

const MAX_TIMEOUT_MS = 120_000;

export async function createRouter(opts: {
  discovery: DiscoveryService;
  logger: LoggerService;
}): Promise<Router> {
  const { discovery, logger } = opts;
  const router = Router();

  router.post('/invoke', async (req, res) => {
    const startedAt = Date.now();

    // 1. Input validation. The route caps timeout at 120s (vs the action's
    // 300s) because users are waiting interactively — anything longer is
    // beyond the threshold of "still feels interactive".
    let inputs;
    try {
      inputs = validateInvokeInput(
        {
          name: req.body?.agentName,
          prompt: req.body?.prompt,
          expectJson: req.body?.expectJson,
          timeoutMs: req.body?.timeoutMs,
        },
        { maxTimeoutMs: MAX_TIMEOUT_MS },
      );
    } catch (e: any) {
      logger.warn(`kagent-suggest — BAD_INPUT: ${e.message}`);
      res.status(200).json({
        ok: false,
        code: 'BAD_INPUT',
        message: e.message,
      });
      return;
    }

    const timeoutMs = inputs.timeoutMs ?? 60_000;
    const expectJson = inputs.expectJson ?? false;

    // 2. Resolve + invoke via the shared library. Any AgentInvocationError
    // is surfaced as {ok:false, code, message}; non-typed errors map to
    // {code: 'AGENT_ERROR'}.
    try {
      const info = await resolveAgent(discovery, inputs.name, logger);
      const text = await invokeAgent(
        info.endpoint,
        inputs.prompt,
        { timeoutMs, stepId: `kagent-suggest-${Date.now()}` },
        logger,
      );

      let response: unknown = text;
      if (expectJson) {
        try {
          response = JSON.parse(text);
        } catch (e: any) {
          res.status(200).json({
            ok: false,
            code: 'INVALID_RESPONSE_JSON',
            message: `Expected JSON response but parse failed: ${e.message}`,
          });
          return;
        }
      }

      const durationMs = Date.now() - startedAt;
      logger.info(
        `kagent-suggest — ok in ${durationMs}ms (agent=${inputs.name}, response length=${text.length})`,
      );

      res.status(200).json({
        ok: true,
        agentName: inputs.name,
        runtime: info.runtime,
        durationMs,
        response,
      });
    } catch (e: any) {
      const code = e instanceof AgentInvocationError ? e.code : 'AGENT_ERROR';
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`kagent-suggest — ${code}: ${message}`);
      res.status(200).json({
        ok: false,
        code,
        message,
      });
    }
  });

  return router;
}
```

- [ ] **Step 5: Run the tests — they pass**

```bash
node packages/backend/node_modules/@backstage/cli/bin/backstage-cli package test --testPathPatterns=kagent-suggest --watchAll=false
```

Expected: `Tests: 8 passed, 8 total`.

- [ ] **Step 6: Create `kagent-suggest/index.ts`** (backend plugin registration)

```typescript
/**
 * kagent-suggest backend plugin
 * ===============================
 *
 * Registers POST /invoke (auto-mounted by Backstage at /api/kagent-suggest/
 * because the pluginId is 'kagent-suggest'). Called by the KagentSuggest
 * frontend field during scaffolder wizard form-fill.
 *
 * Internally calls the kagent-shared library (resolver + invoker) — same
 * code path as the kagent:agent:invoke scaffolder action, just exposed
 * over HTTP for interactive use.
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 */
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { createRouter } from './router';

const kagentSuggestPlugin = createBackendPlugin({
  pluginId: 'kagent-suggest',
  register({ registerInit }) {
    registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        discovery: coreServices.discovery,
        logger: coreServices.logger,
      },
      async init({ httpRouter, discovery, logger }) {
        const router = await createRouter({ discovery, logger });
        httpRouter.use(router);
      },
    });
  },
});

export default kagentSuggestPlugin;
```

- [ ] **Step 7: Register the module in `packages/backend/src/index.ts`**

Find the line after the scaffolder custom-actions module registration. Add:

```typescript
// kagent-suggest: HTTP route for the KagentSuggest frontend field to call
// kagent agents during scaffolder wizard form-fill. Shares the kagent-shared
// library with the kagent:agent:invoke scaffolder action.
backend.add(import('./modules/kagent-suggest'));
```

Place this directly after the scaffolder module's `backend.add(...)`.

- [ ] **Step 8: Run the full backend test suite + verify boot**

```bash
node packages/backend/node_modules/@backstage/cli/bin/backstage-cli package test --watchAll=false
```

Expected: all tests pass (8 new + 21 existing kagent-shared/action tests + all other backend tests).

Type-check:

```bash
yarn tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/backend/src/modules/kagent-suggest/ packages/backend/src/index.ts
git commit -m "feat(kagent): add kagent-suggest backend module + HTTP route

POST /api/kagent-suggest/invoke — a thin HTTP wrapper over the
kagent-shared library that lets the upcoming KagentSuggest frontend
field call kagent agents during scaffolder wizard form-fill.

Caps timeoutMs at 120000 (vs the action's 300000) because users are
waiting interactively. Always returns HTTP 200 — failures surface as
{ok:false, code, message} in the body for inline rendering. Uses
Backstage's standard backend auth middleware.

Covered by 8 new unit tests via supertest."
```

---

## Task 3: Add `KagentSuggest` React field

Create the React component, register it as a scaffolder field extension, wire into App.tsx.

**Files:**
- Modify: `packages/app/package.json`
- Create: `packages/app/src/scaffolder/KagentSuggestField/KagentSuggestField.tsx`
- Create: `packages/app/src/scaffolder/KagentSuggestField/extension.tsx`
- Create: `packages/app/src/scaffolder/KagentSuggestField/index.ts`
- Create: `packages/app/src/scaffolder/KagentSuggestField/KagentSuggestField.test.tsx`
- Modify: `packages/app/src/App.tsx`

- [ ] **Step 1: Add `@backstage/plugin-scaffolder-react` to the app**

```bash
yarn workspace app add @backstage/plugin-scaffolder-react@^1.41.0
```

(Version `^1.41.0` matches the Backstage v1.48 release line; adjust if `yarn` reports a different available version. The dep is normally pulled in transitively by `@backstage/plugin-scaffolder` but we need a direct import for `createScaffolderFieldExtension`.)

- [ ] **Step 2: Write the failing component tests**

Create `packages/app/src/scaffolder/KagentSuggestField/KagentSuggestField.test.tsx`:

```typescript
/**
 * Unit tests for the KagentSuggest field component.
 *
 * Uses @testing-library/react + jest.spyOn(global, 'fetch') to mock the
 * backend route. The field reads props via rjsf's FieldExtensionComponentProps,
 * which we synthesize manually in each test.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KagentSuggestField } from './KagentSuggestField';

function buildProps(overrides: any = {}) {
  return {
    formData: '',
    onChange: jest.fn(),
    uiSchema: {
      'ui:options': {
        agent: 'skill-suggester',
        targetField: 'skills',
        promptTemplate: 'Suggest skills for: "{{ description }}"',
        watchFields: ['description'],
        itemShape: { id: 'text', name: 'text', description: 'text' },
        buttonLabel: 'Suggest skills',
        ...overrides.uiOptions,
      },
    },
    formContext: {
      formData: overrides.formData ?? { description: '', skills: [] },
      onChange: jest.fn(),
    },
    ...overrides.extra,
  } as any;
}

function mockOkResponse(items: any[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      agentName: 'skill-suggester',
      runtime: 'kagent',
      durationMs: 1234,
      response: items,
    }),
  } as any;
}

function mockFailResponse(code: string, message: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: false, code, message }),
  } as any;
}

describe('KagentSuggestField', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('renders with disabled button when watched field is empty', () => {
    render(<KagentSuggestField {...buildProps({ formData: { description: '' } })} />);
    const btn = screen.getByRole('button', { name: /suggest skills/i });
    expect(btn).toBeDisabled();
  });

  it('enables button when watched field is non-empty', () => {
    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    const btn = screen.getByRole('button', { name: /suggest skills/i });
    expect(btn).toBeEnabled();
  });

  it('click fires fetch to /api/kagent-suggest/invoke with the right body', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('/api/kagent-suggest/invoke');
    const body = JSON.parse(call[1].body);
    expect(body.agentName).toBe('skill-suggester');
    expect(body.expectJson).toBe(true);
    expect(body.prompt).toContain('Suggest skills for: "My agent"');
  });

  it('mustache interpolation — {{ description }} pulls from formContext.formData.description', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'unique-test-value-xyz' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.prompt).toContain('unique-test-value-xyz');
    expect(body.prompt).not.toContain('{{ description }}');
  });

  it('loading state — button disabled and shows spinner during fetch', async () => {
    let resolveFetch: any;
    fetchSpy.mockImplementationOnce(
      () => new Promise(r => { resolveFetch = r; }),
    );

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /suggest skills/i })).toBeDisabled();

    // Resolve so the test cleans up.
    resolveFetch(mockOkResponse([]));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  });

  it('happy path — suggestions render as preview rows with editable inputs', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
      { id: 'classify', name: 'Classify', description: 'Labels input.' },
    ]));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Parse Text')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Extracts entities.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('classify')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^add$/i })).toHaveLength(2);
  });

  it('Add button — calls formContext.onChange with the merged target array', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({
      formData: { description: 'My agent', skills: [{ id: 'existing', name: 'Existing', description: 'x' }] },
    });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(props.formContext.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: [
          { id: 'existing', name: 'Existing', description: 'x' },
          { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
        ],
      }),
    );
  });

  it('Add twice — both calls append to the array (no dedupe)', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({ formData: { description: 'My agent', skills: [] } });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    const addBtn = screen.getByRole('button', { name: /^add$/i });
    await userEvent.click(addBtn);
    await userEvent.click(addBtn);

    expect(props.formContext.onChange).toHaveBeenCalledTimes(2);
  });

  it('AGENT_NOT_FOUND — shows user-facing error, no suggestions render, button re-enables', async () => {
    fetchSpy.mockResolvedValueOnce(mockFailResponse('AGENT_NOT_FOUND', 'no entity'));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/not in the catalog yet/i);
    expect(screen.queryByDisplayValue(/parse-text/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /suggest skills/i })).toBeEnabled();
  });

  it('INVALID_RESPONSE_JSON — shows operator-action-required message', async () => {
    fetchSpy.mockResolvedValueOnce(mockFailResponse('INVALID_RESPONSE_JSON', 'bad json'));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/didn't return valid JSON/i);
  });

  it('edit-then-Add — modifying preview row text before Add appends edited values', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({ formData: { description: 'My agent', skills: [] } });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    const idInput = screen.getByDisplayValue('parse-text');
    fireEvent.change(idInput, { target: { value: 'edited-id' } });

    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(props.formContext.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: [
          expect.objectContaining({ id: 'edited-id' }),
        ],
      }),
    );
  });

  it('unmount during loading — AbortController is called', async () => {
    let abortCalled = false;
    fetchSpy.mockImplementationOnce((_url: string, init: any) => {
      init.signal?.addEventListener('abort', () => { abortCalled = true; });
      return new Promise(() => {});
    });

    const { unmount } = render(
      <KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    unmount();

    await waitFor(() => expect(abortCalled).toBe(true));
  });
});
```

- [ ] **Step 3: Run the tests — they fail because the module doesn't exist**

```bash
node packages/app/node_modules/@backstage/cli/bin/backstage-cli package test --testPathPatterns=KagentSuggestField --watchAll=false
```

Expected: FAIL with `Cannot find module './KagentSuggestField'`.

- [ ] **Step 4: Create `KagentSuggestField.tsx`** (the React component)

```tsx
/**
 * KagentSuggest scaffolder field — calls a kagent agent during wizard form-fill
 * and lets the user accept suggestions item-by-item into a target form array.
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 *
 * IMPORTANT: this field never sets its own form value. It mutates a different
 * form field (specified by ui:options.targetField) via formContext.onChange.
 * The field's own value (the dummy string property in the template schema)
 * stays empty.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  CircularProgress,
  Paper,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';

export interface KagentSuggestOptions {
  agent: string;
  targetField: string;
  promptTemplate: string;
  watchFields?: string[];
  itemShape: Record<string, 'text' | 'multiline'>;
  buttonLabel?: string;
  maxSuggestions?: number;
  timeoutMs?: number;
}

export interface KagentSuggestFieldProps {
  formData: string;
  onChange: (value: string) => void;
  uiSchema: { 'ui:options': KagentSuggestOptions };
  formContext: {
    formData: Record<string, unknown>;
    onChange: (data: Record<string, unknown>) => void;
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  AGENT_NOT_FOUND:
    'Agent is not in the catalog yet. Ask an operator to scaffold it before trying again.',
  INVALID_CONTRACT:
    'Agent is missing the v1 annotation contract. Re-scaffold it through the IDP wizard.',
  ENDPOINT_UNREACHABLE:
    "Couldn't reach the agent service. Is the kagent namespace up?",
  INVOCATION_TIMEOUT:
    "The agent didn't respond in time. Try simplifying the prompt or retrying.",
  AGENT_ERROR:
    'The agent returned an error. Check the agent\'s pod logs.',
  INVALID_RESPONSE_JSON:
    "The agent didn't return valid JSON. Either ask the operator to tune the agent's system message, or contact platform-eng.",
  BAD_INPUT:
    'Internal: the suggest field sent an invalid request. Reload the wizard.',
};

const useStyles = makeStyles(theme => ({
  root: { marginBottom: theme.spacing(2) },
  button: { marginRight: theme.spacing(1) },
  loading: { marginLeft: theme.spacing(1), verticalAlign: 'middle' },
  alert: { marginTop: theme.spacing(1) },
  preview: { marginTop: theme.spacing(2) },
  previewItem: {
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1),
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
  },
  previewFields: { flex: 1 },
  added: { color: theme.palette.success.main, marginLeft: theme.spacing(1) },
}));

function renderPrompt(
  template: string,
  values: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const v = values[key];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

interface SuggestionEntry {
  data: Record<string, string>;
  added: boolean;
  addedAt?: number;
}

export function KagentSuggestField(props: KagentSuggestFieldProps) {
  const classes = useStyles();
  const opts = props.uiSchema['ui:options'];
  const formData = props.formContext?.formData ?? {};
  const targetArray = (formData[opts.targetField] as any[]) ?? [];

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup any in-flight fetch on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const buttonDisabled = (() => {
    if (loading) return true;
    const watch = opts.watchFields ?? [];
    return watch.some(f => {
      const v = formData[f];
      return v == null || (typeof v === 'string' && v.trim() === '');
    });
  })();

  const handleSuggest = useCallback(async () => {
    setError(null);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const prompt = renderPrompt(opts.promptTemplate, formData);

    try {
      const res = await fetch('/api/kagent-suggest/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentName: opts.agent,
          prompt,
          expectJson: true,
          timeoutMs: opts.timeoutMs ?? 60_000,
        }),
        signal: controller.signal,
      });

      const body = await res.json();
      if (!body.ok) {
        setError({ code: body.code, message: body.message });
        setSuggestions([]);
        return;
      }

      const raw = body.response;
      const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
      const max = opts.maxSuggestions ?? 10;
      const expectedKeys = Object.keys(opts.itemShape);

      const filtered = arr
        .filter(item =>
          item && typeof item === 'object' && expectedKeys.every(k => k in item),
        )
        .slice(0, max)
        .map(item => {
          const entry: Record<string, string> = {};
          for (const k of expectedKeys) entry[k] = String(item[k] ?? '');
          return { data: entry, added: false } as SuggestionEntry;
        });

      setSuggestions(filtered);
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // unmounted
      setError({ code: 'BAD_INPUT', message: e.message ?? String(e) });
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, [opts, formData]);

  const handleEditSuggestion = (idx: number, key: string, value: string) => {
    setSuggestions(prev => {
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        data: { ...next[idx].data, [key]: value },
      };
      return next;
    });
  };

  const handleAdd = (idx: number) => {
    const entry = suggestions[idx];
    const newArr = [...targetArray, entry.data];
    props.formContext.onChange({
      ...formData,
      [opts.targetField]: newArr,
    });

    // Mark as added for 2 seconds.
    setSuggestions(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], added: true, addedAt: Date.now() };
      return next;
    });
    setTimeout(() => {
      setSuggestions(prev => {
        const next = [...prev];
        if (next[idx]) next[idx] = { ...next[idx], added: false };
        return next;
      });
    }, 2000);
  };

  return (
    <div className={classes.root}>
      <Button
        variant="outlined"
        color="primary"
        disabled={buttonDisabled}
        onClick={handleSuggest}
        className={classes.button}
      >
        {opts.buttonLabel ?? 'Suggest'}
      </Button>
      {loading && <CircularProgress size={20} className={classes.loading} role="progressbar" />}

      {error && (
        <Paper className={classes.alert} elevation={0} role="alert">
          <Typography color="error">
            {ERROR_MESSAGES[error.code] ?? `${error.code}: ${error.message}`}
          </Typography>
        </Paper>
      )}

      {suggestions.length > 0 && (
        <div className={classes.preview}>
          <Typography variant="subtitle2">Suggestions:</Typography>
          {suggestions.map((entry, idx) => (
            <Paper key={idx} className={classes.previewItem} variant="outlined">
              <div className={classes.previewFields}>
                {Object.entries(opts.itemShape).map(([key, kind]) => (
                  <TextField
                    key={key}
                    label={key}
                    value={entry.data[key]}
                    onChange={e => handleEditSuggestion(idx, key, e.target.value)}
                    fullWidth
                    multiline={kind === 'multiline'}
                    margin="dense"
                  />
                ))}
              </div>
              <Button
                variant="contained"
                color="primary"
                size="small"
                onClick={() => handleAdd(idx)}
              >
                Add
              </Button>
              {entry.added && (
                <Typography variant="caption" className={classes.added}>
                  ✓ Added
                </Typography>
              )}
            </Paper>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create the scaffolder field extension wrapper**

Create `packages/app/src/scaffolder/KagentSuggestField/extension.tsx`:

```typescript
import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import { KagentSuggestField } from './KagentSuggestField';

export const KagentSuggestFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    component: KagentSuggestField as any,
    name: 'KagentSuggest',
  }),
);
```

- [ ] **Step 6: Create `index.ts`** (re-exports)

```typescript
export { KagentSuggestField } from './KagentSuggestField';
export { KagentSuggestFieldExtension } from './extension';
```

- [ ] **Step 7: Run the component tests — they pass**

```bash
node packages/app/node_modules/@backstage/cli/bin/backstage-cli package test --testPathPatterns=KagentSuggestField --watchAll=false
```

Expected: `Tests: 12 passed, 12 total`.

If any test fails, fix the component (not the test) and re-run.

- [ ] **Step 8: Wire the extension into `App.tsx`**

Open `packages/app/src/App.tsx`. Add the import (after the existing scaffolder import on ~line 40):

```typescript
import { ScaffolderFieldExtensions } from '@backstage/plugin-scaffolder-react';
import { KagentSuggestFieldExtension } from './scaffolder/KagentSuggestField';
```

Find the `<Route path="/create" element={<ScaffolderPage />} />` line (around line 219). Change it from a self-closing element to one with children that register the field extension:

```tsx
{/* SCAFFOLDER: Create new projects/components from software templates */}
<Route path="/create" element={<ScaffolderPage />}>
  <ScaffolderFieldExtensions>
    <KagentSuggestFieldExtension />
  </ScaffolderFieldExtensions>
</Route>
```

- [ ] **Step 9: Type-check the app**

```bash
yarn workspace app tsc --noEmit
```

Expected: no errors. If the import for `ScaffolderFieldExtensions` is reported as not exported, check the installed version of `@backstage/plugin-scaffolder-react` — newer versions may re-export it from a different path; adjust the import to `@backstage/plugin-scaffolder` if needed.

- [ ] **Step 10: Run the existing app tests to ensure App.tsx still renders**

```bash
node packages/app/node_modules/@backstage/cli/bin/backstage-cli package test --testPathPatterns=App.test --watchAll=false
```

Expected: `App › should render` passes.

- [ ] **Step 11: Commit**

```bash
git add packages/app/package.json packages/app/src/scaffolder/ packages/app/src/App.tsx
git commit -m "feat(kagent): add KagentSuggest scaffolder field extension

Custom Backstage frontend field (registered as ui:field: KagentSuggest)
that calls a kagent agent via POST /api/kagent-suggest/invoke during
wizard form-fill. Renders a button + preview list with per-item Add
affordance.

Generic field — configured per use via ui:options (target agent, prompt
template with mustache placeholders, watched fields for button enable,
item shape for preview rendering).

Covered by 12 component unit tests using @testing-library/react and
mocked global.fetch. Wired into <ScaffolderPage> in App.tsx so any
template can use ui:field: KagentSuggest."
```

---

## Task 4: Wire `ui:field: KagentSuggest` into the kagent-agent template

Activate the field on the Skills page so users see it during the kagent-agent wizard.

**Files:**
- Modify: `examples/templates/kagent-agent/template.yaml`

- [ ] **Step 1: Find the Skills page (line ~112 in template.yaml)**

```bash
grep -n "A2A Skills" examples/templates/kagent-agent/template.yaml
```

Expected: line number around 112.

- [ ] **Step 2: Add the `skillSuggest` property at the top of the Skills page properties**

In `examples/templates/kagent-agent/template.yaml`, locate:

```yaml
    # --- WIZARD PAGE 3: A2A Skills (optional) ---
    - title: A2A Skills (optional)
      description: >-
        Define A2A skill metadata so the kagent UI and other agents can
        discover this agent's capabilities. Leave empty if you don't need
        the agent to advertise itself.
      properties:
        skills:
```

Replace `      properties:` (and the next line) with:

```yaml
      properties:
        skillSuggest:
          type: string
          title: AI assist (optional)
          ui:field: KagentSuggest
          ui:options:
            agent: skill-suggester
            targetField: skills
            promptTemplate: |
              Suggest 3 A2A skills for a kagent agent described as:
              "{{ description }}"
              Respond with ONLY a JSON array of exactly 3 objects, each with:
                - id: kebab-case identifier
                - name: Title Case display name
                - description: one-sentence summary
              No prose. No markdown. Just the JSON array.
            watchFields: [description]
            itemShape:
              id: text
              name: text
              description: text
            buttonLabel: Suggest skills
            maxSuggestions: 3
            timeoutMs: 60000
        skills:
```

- [ ] **Step 3: Sanity-check the YAML parses**

```bash
node -e "console.log(require('yaml').parse(require('fs').readFileSync('examples/templates/kagent-agent/template.yaml', 'utf8')).spec.parameters[2].properties.skillSuggest['ui:field'])"
```

Expected output: `KagentSuggest`. If you don't have the `yaml` package available, use:

```bash
python3 -c "import yaml; d = yaml.safe_load(open('examples/templates/kagent-agent/template.yaml')); print(d['spec']['parameters'][2]['properties']['skillSuggest']['ui:field'])"
```

Same expected output.

- [ ] **Step 4: Commit**

```bash
git add examples/templates/kagent-agent/template.yaml
git commit -m "feat(kagent): wire KagentSuggest into kagent-agent template

Adds a 'AI assist' field at the top of the A2A Skills page that calls
the skill-suggester agent to propose three skills based on the user's
description. The user can edit each suggestion and click Add to append
it to the actual Skills array.

Requires:
- KagentSuggest field extension shipped in the backend image
- skill-suggester kagent agent deployed (one-time scaffold via the
  same template; see Task 5 of the implementation plan for the system
  message it should use)"
```

---

## Task 5: Layer 2 manual validation in deployed cluster

User-gated. **The user handles the Docker image build/push.** This task documents the manual checklist for verifying the feature works end-to-end, then records the result in this plan.

**Pre-requisite scaffolding** (one-time, before validation): create the `skill-suggester` agent via the existing kagent-agent wizard, with this configuration:

- **Name:** `skill-suggester`
- **Description:** "Suggests A2A skills for new kagent agents based on a one-line description."
- **Owner:** any (e.g., `group:platform-engineering`)
- **System message** (paste into the wizard's System Message textarea):
  ```
  You are a skill-suggester for kagent agents.

  When the user describes an agent in one or two sentences, respond with
  ONLY a JSON array of exactly 3 A2A skill objects. Each object must have:
    - id: kebab-case identifier
    - name: Title Case display name
    - description: one-sentence summary

  Output ONLY the JSON array. No prose. No markdown. No code fences.

  Example output:
  [
    {"id":"parse-text","name":"Parse Text","description":"Extracts entities from input text."},
    {"id":"classify-intent","name":"Classify Intent","description":"Labels user input with one of N intents."},
    {"id":"answer-faq","name":"Answer FAQ","description":"Looks up answers in a known knowledge base."}
  ]
  ```
- **Builtin prompts:** disabled (this agent doesn't need cluster context).
- **Delegates:** none (leaf agent).
- **Skills:** leave empty (this agent advertises no skills itself).
- **Resources:** defaults.

Submit the wizard → review and merge the resulting PR → wait ~30s for ArgoCD sync → confirm with `kubectl get agents.kagent.dev skill-suggester -n kagent` that it's `READY`.

**Files:**
- Modify: `docs/superpowers/plans/2026-05-21-kagent-suggest-field.md` (append "Layer 2 Validation Result")

- [ ] **Step 1: Wait for the user to confirm the new image is deployed AND `skill-suggester` is running**

```bash
kubectl get agents.kagent.dev skill-suggester -n kagent
```

Expected: `READY True`.

- [ ] **Step 2: Open the kagent-agent wizard and fill in the Identity page**

1. Navigate to `https://backstage.arigsela.com/create`
2. Click **Kagent Declarative Agent**
3. Fill in:
   - Agent name: `test-suggest-agent` (or any throwaway name)
   - Description: `"An agent that answers questions about the company's holiday schedule and PTO policy."`
   - Owner: `group:platform-engineering`
4. Click Next.

- [ ] **Step 3: Skip the Behavior page**

Accept defaults. Click Next.

- [ ] **Step 4: On the A2A Skills page, click "Suggest skills"**

The AI assist block should be at the top with a button labeled "Suggest skills". Click it.

Expected:
- Button shows a spinner for ~5-10 seconds.
- Three preview rows appear with editable id/name/description fields, each with an "Add" button.
- Each row's id should be kebab-case, name in Title Case, description one sentence.

- [ ] **Step 5: Edit one suggestion's description, then click Add**

Modify the description of the first suggestion (e.g., add "with caveats" at the end). Click its "Add" button.

Expected:
- "✓ Added" badge briefly appears next to that row.
- The Skills array below now contains one item — with the edited description.

- [ ] **Step 6: Click Add on the second suggestion, leave the third alone**

Expected:
- Skills array now has 2 items.
- Third suggestion is still in the preview with its Add button enabled.

- [ ] **Step 7: Submit the wizard**

Click Next through Resources, then "Create" on Publish.

Expected:
- A PR is opened against `arigsela/kubernetes` with the two added skills present in the Agent CRD's `spec.declarative.a2aConfig.skills`.

- [ ] **Step 8: Record the validation result**

Append to this file under a new section directly below the Goal/Architecture/Tech Stack header, titled `## Layer 2 Validation Result (YYYY-MM-DD)`. Include:

1. **Wall-clock duration** of the Suggest call (e.g., "~7s").
2. **The three suggestions verbatim** (so we know what skill-suggester produces).
3. **The edits made** before clicking Add (so behavior is reproducible).
4. **The contents of `spec.declarative.a2aConfig.skills`** in the resulting PR (verifies the Add → form → render pipeline).
5. **Any UX issues observed** (e.g., loading state confusing, button mis-aligned).

- [ ] **Step 9: Close (don't merge) the test PR if you don't actually want a `test-suggest-agent` deployed**

The PR exists only to validate the form-render pipeline. Close it.

- [ ] **Step 10: Commit the validation findings**

```bash
git add docs/superpowers/plans/2026-05-21-kagent-suggest-field.md
git commit -m "docs(plan): record Layer 2 validation result for KagentSuggest field

Live test against skill-suggester in the deployed cluster: <success/
failure summary>. <Any UX or behavior issues captured.>"
```

---

## Final checklist

- [ ] All 5 tasks committed.
- [ ] `yarn workspace backend test --watchAll=false` passes (8 new route tests + 21 unchanged kagent-shared/action tests).
- [ ] `yarn workspace app test --watchAll=false` passes (12 new field tests + existing App test).
- [ ] `yarn tsc --noEmit` clean across both packages.
- [ ] The plan file contains the Layer 2 validation result.
- [ ] No leftover throwaway test scaffolding (no `_test-kagent-suggest/` directory, no orphaned config entries).
- [ ] PR description references this plan and the design spec.

## Self-review notes

Spec coverage verified — each section of the spec maps to at least one task:

- Spec §2 (Approach) → Tasks 1, 2, 3
- Spec §3 (Architecture) → Tasks 1 (shared library), 2 (route), 3 (field)
- Spec §4 (Backend API) → Task 2 (route + tests)
- Spec §5 (Frontend props/ui:options) → Task 3 (component)
- Spec §6 (Error handling) → Task 3 (component + tests) and Task 2 (route tests)
- Spec §7 (Testing) → Tasks 1, 2, 3 (Layer 1 backend + frontend), Task 5 (Layer 2 manual)
- Spec §8 (Rollout) → Tasks 1–5 in the order the spec specifies
- Spec §9 (Out of scope) → confirmed nothing in this plan touches streaming, multi-turn, caching, or per-user permissions

No placeholders. All code blocks contain complete implementations. Type names consistent across tasks (`EndpointInfo`, `InvokeOptions`, `ValidatedInput`, `KagentSuggestOptions`, `SuggestionEntry`).
