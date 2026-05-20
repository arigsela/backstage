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
