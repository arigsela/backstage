/**
 * Unit tests for the kagent 1.0 A2A client (invokeAgent), against recorded
 * response shapes in __fixtures__/a2a.ts.
 */
import { AgentInvocationError } from './errors';
import { invokeAgent, resultText, sendNotAcceptedDelayMs } from './invoker';
import {
  a2aResponse,
  completedTask,
  completedTaskWithToolCall,
  endedTask,
  messageResult,
  rpcError,
  sendNotAccepted,
} from './__fixtures__/a2a';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

const ENDPOINT =
  'http://kagent-controller.kagent.svc.cluster.local:8083/agents/kagent/foo-agent';
const OPTS = { timeoutMs: 60000, stepId: 'step-1' };

describe('invokeAgent', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns the text of a completed task', async () => {
    fetchSpy.mockResolvedValueOnce(
      a2aResponse(completedTask('Hello from the agent.')),
    );

    await expect(invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger())).resolves.toBe(
      'Hello from the agent.',
    );
  });

  it('joins text artifacts and skips tool-call data parts', async () => {
    fetchSpy.mockResolvedValueOnce(a2aResponse(completedTaskWithToolCall()));

    await expect(invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger())).resolves.toBe(
      'Let me check the cluster.\nAll pods are Running.',
    );
  });

  it('accepts a direct Message result', async () => {
    fetchSpy.mockResolvedValueOnce(a2aResponse(messageResult('direct reply')));

    await expect(invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger())).resolves.toBe(
      'direct reply',
    );
  });

  it('sends an A2A v1 SendMessage with the v1 headers', async () => {
    fetchSpy.mockResolvedValueOnce(a2aResponse(completedTask('ok')));

    await invokeAgent(
      ENDPOINT,
      'hi',
      { ...OPTS, userId: 'someone' },
      mockLogger(),
    );

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
      'X-User-Id': 'someone',
    });
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 'step-1',
      method: 'SendMessage',
      params: {
        message: {
          messageId: expect.any(String),
          role: 'ROLE_USER',
          parts: [{ text: 'hi' }],
        },
      },
    });
    // No contextId: every call starts a new kagent Session.
    expect(body.params.message.contextId).toBeUndefined();
  });

  it('defaults X-User-Id to the portal identity', async () => {
    fetchSpy.mockResolvedValueOnce(a2aResponse(completedTask('ok')));

    await invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger());

    expect(fetchSpy.mock.calls[0][1].headers['X-User-Id']).toBe(
      'backstage-portal',
    );
  });

  it.each(['TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED'])(
    'AGENT_ERROR when the task ends in %s, carrying the status text',
    async state => {
      fetchSpy.mockResolvedValueOnce(
        a2aResponse(endedTask(state, 'model call failed: 403')),
      );

      await expect(
        invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger()),
      ).rejects.toMatchObject({
        code: 'AGENT_ERROR',
        message: expect.stringContaining(`${state}: model call failed: 403`),
      });
    },
  );

  it('AGENT_ERROR when the agent pauses for an approval', async () => {
    fetchSpy.mockResolvedValueOnce(
      a2aResponse(endedTask('TASK_STATE_INPUT_REQUIRED', 'approve delete?')),
    );

    await expect(
      invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger()),
    ).rejects.toMatchObject({
      code: 'AGENT_ERROR',
      message: expect.stringContaining('TASK_STATE_INPUT_REQUIRED'),
    });
  });

  it('retries a KAGENT_SEND_NOT_ACCEPTED rejection with the identical request', async () => {
    fetchSpy
      .mockResolvedValueOnce(a2aResponse(sendNotAccepted()))
      .mockResolvedValueOnce(a2aResponse(completedTask('second time lucky')));

    await expect(invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger())).resolves.toBe(
      'second time lucky',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1].body).toBe(fetchSpy.mock.calls[0][1].body);
  });

  it('does not retry other JSON-RPC errors', async () => {
    fetchSpy.mockResolvedValueOnce(a2aResponse(rpcError(-32603, 'internal')));

    await expect(
      invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger()),
    ).rejects.toMatchObject({
      code: 'AGENT_ERROR',
      message: expect.stringContaining('-32603'),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('AGENT_ERROR on HTTP 500', async () => {
    fetchSpy.mockResolvedValueOnce(a2aResponse({}, 500));

    await expect(
      invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger()),
    ).rejects.toMatchObject({
      code: 'AGENT_ERROR',
      message: expect.stringContaining('500'),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries one network error with the same message, then ENDPOINT_UNREACHABLE', async () => {
    const networkErr = new TypeError('fetch failed');
    (networkErr as any).cause = { code: 'ECONNREFUSED' };
    fetchSpy
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr);

    const result = invokeAgent(ENDPOINT, 'hi', OPTS, mockLogger());

    await expect(result).rejects.toBeInstanceOf(AgentInvocationError);
    await expect(result).rejects.toMatchObject({
      code: 'ENDPOINT_UNREACHABLE',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1].body).toBe(fetchSpy.mock.calls[0][1].body);
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

    await expect(
      invokeAgent(
        ENDPOINT,
        'hi',
        { timeoutMs: 50, stepId: 'step-1' },
        mockLogger(),
      ),
    ).rejects.toMatchObject({ code: 'INVOCATION_TIMEOUT' });
  });
});

describe('resultText', () => {
  it('puts the status message text before the artifacts', () => {
    const body = completedTask('answer');
    body.result.task.status.message = { parts: [{ text: 'status note' }] };
    expect(resultText(body.result)).toBe('status note\nanswer');
  });

  it('returns empty text when there is no text part', () => {
    expect(
      resultText({ task: { artifacts: [{ parts: [{ data: {} }] }] } }),
    ).toBe('');
    expect(resultText(undefined)).toBe('');
  });
});

describe('sendNotAcceptedDelayMs', () => {
  it('reads retryAfterMs from the ErrorInfo detail', () => {
    expect(sendNotAcceptedDelayMs(sendNotAccepted().error)).toBe(1);
  });

  it('ignores the reason on any other error code', () => {
    const error = { ...sendNotAccepted().error, code: -32603 };
    expect(sendNotAcceptedDelayMs(error)).toBeUndefined();
  });

  it('ignores -32004 without the kagent reason', () => {
    expect(
      sendNotAcceptedDelayMs({ code: -32004, message: 'unsupported' }),
    ).toBeUndefined();
  });
});
