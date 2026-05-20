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
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'http://localhost:7007/api/catalog/entities/by-name/component/default/foo-agent',
      expect.anything(),
    );
  });
});
