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
