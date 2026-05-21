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
