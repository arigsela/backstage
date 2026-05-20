/**
 * Unit tests for kagent:agent:invoke action.
 *
 * Mocks:
 *   - global.fetch via jest.spyOn (covers both catalog and A2A HTTP calls).
 *   - DiscoveryService via a plain object literal.
 *   - ActionContext via a local helper (the upstream createMockActionContext
 *     is not exported from @backstage/plugin-scaffolder-node@0.12.5).
 */

import { createKagentInvokeAction, AgentInvocationError } from './kagentInvokeAction';

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
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://localhost:7007/api/catalog/entities/by-name/component/default/foo-agent',
    );
  });
});

// A2A response shape per the live probe (Task 1):
//   .result is a Task object with .artifacts[].parts[].text
//   parts use `kind` (not `type`) on the way out
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

describe('kagent:agent:invoke — A2AClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path — concatenates text parts from artifacts', async () => {
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

  it('request body includes messageId (required by kagent A2A)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('ok'));

    const action = createKagentInvokeAction({ discovery: mockDiscovery() });
    const ctx = createMockActionContext({
      input: { name: 'foo-agent', prompt: 'hi' },
    });

    await action.handler(ctx);

    const a2aCall = fetchSpy.mock.calls[1];
    const body = JSON.parse((a2aCall[1] as any).body);
    expect(body.method).toBe('message/send');
    expect(body.params.message.messageId).toEqual(expect.any(String));
    expect(body.params.message.messageId.length).toBeGreaterThan(0);
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
