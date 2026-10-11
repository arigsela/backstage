/**
 * Recorded-shape fixtures for the kagent 1.0 A2A gateway, used by the
 * kagent-shared, kagent-suggest and kagent:agent:invoke tests.
 *
 * Shapes follow kagent v1.0.0-alpha11 (docs/architecture/a2a-transports.md,
 * go/core/internal/a2agateway/http.go) and the a2a-go v2.6.0 JSON encoding it
 * pins (a2a/core.go: StreamResponse wraps the result as {task} or {message};
 * roles are ROLE_*, states TASK_STATE_*; a Part is flattened to {text} /
 * {data} / {url} / {raw}). The Go ADK runtime emits one artifact per ADK
 * event (adka2a OutputArtifactPerEvent), so a tool-using answer arrives as
 * narration text, tool-call and tool-result data parts, then the answer.
 */

const TASK_ID = '7a1d2c4e-5b6f-4a8b-9c0d-1e2f3a4b5c6d';
const CONTEXT_ID = '3f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';

export function a2aResponse(body: object, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

/** A completed task whose only artifact is `text` (a tool-less agent). */
export function completedTask(text: string): any {
  return {
    jsonrpc: '2.0',
    id: 'step-1',
    result: {
      task: {
        id: TASK_ID,
        contextId: CONTEXT_ID,
        status: {
          state: 'TASK_STATE_COMPLETED',
          timestamp: '2026-10-11T12:00:05Z',
        },
        artifacts: [
          {
            artifactId: 'art-1',
            parts: [{ text }],
            metadata: {
              'kagent.dev/a2a/timeline-position': '2026-10-11T12:00:04Z',
            },
          },
        ],
        history: [
          {
            messageId: 'msg-1',
            role: 'ROLE_USER',
            contextId: CONTEXT_ID,
            taskId: TASK_ID,
            parts: [{ text: 'hi' }],
          },
        ],
        metadata: { 'kagent.dev/a2a/task-created-at': '2026-10-11T12:00:00Z' },
      },
    },
  };
}

/** A completed task with narration, one tool round trip, then the answer. */
export function completedTaskWithToolCall(): any {
  const body = completedTask('unused');
  body.result.task.artifacts = [
    {
      artifactId: 'art-1',
      parts: [{ text: 'Let me check the cluster.' }],
      metadata: {},
    },
    {
      artifactId: 'art-2',
      parts: [
        {
          data: {
            id: 'call-1',
            name: 'k8s_get_resources',
            args: { resource_type: 'pods' },
          },
          metadata: { 'kagent.dev/a2a/part-type': 'function_call' },
        },
      ],
      metadata: {},
    },
    {
      artifactId: 'art-3',
      parts: [
        {
          data: {
            id: 'call-1',
            name: 'k8s_get_resources',
            response: { result: 'pod-a Running' },
          },
          metadata: { 'kagent.dev/a2a/part-type': 'function_response' },
        },
      ],
      metadata: {},
    },
    {
      artifactId: 'art-4',
      parts: [{ text: 'All pods are Running.' }],
      metadata: {},
    },
  ];
  return body;
}

/** A task that ended in `state` with an agent status message. */
export function endedTask(state: string, statusText: string): any {
  const body = completedTask('unused');
  body.result.task.artifacts = [];
  body.result.task.status = {
    state,
    message: {
      messageId: 'msg-2',
      role: 'ROLE_AGENT',
      contextId: CONTEXT_ID,
      taskId: TASK_ID,
      parts: [{ text: statusText }],
    },
  };
  return body;
}

/** A direct Message result (no task). */
export function messageResult(text: string) {
  return {
    jsonrpc: '2.0',
    id: 'step-1',
    result: {
      message: {
        messageId: 'msg-3',
        role: 'ROLE_AGENT',
        contextId: CONTEXT_ID,
        parts: [{ text }],
      },
    },
  };
}

/** The gateway's retryable rejection (session busy; nothing dispatched). */
export function sendNotAccepted() {
  return {
    jsonrpc: '2.0',
    id: 'step-1',
    error: {
      code: -32004,
      message:
        'input was not accepted; retry after the session becomes available',
      data: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'UNSUPPORTED_OPERATION',
          domain: 'a2a-protocol.org',
          metadata: {
            reason: 'KAGENT_SEND_NOT_ACCEPTED',
            retryAfterMs: '1',
            timestamp: '2026-10-11T12:00:00Z',
          },
        },
      ],
    },
  };
}

export function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: 'step-1', error: { code, message } };
}

/** A catalog entity as TeraSky's ingestor builds it from a v1alpha3 Agent. */
export function agentEntity(
  overrides: {
    annotations?: Record<string, any>;
    spec?: Record<string, any>;
  } = {},
) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'foo-agent',
      namespace: 'default',
      annotations: {
        'terasky.backstage.io/add-to-catalog': 'true',
        'terasky.backstage.io/component-type': 'kagent-agent',
        'terasky.backstage.io/kubernetes-resource-kind': 'Agent',
        'terasky.backstage.io/kubernetes-resource-name': 'foo-agent',
        'terasky.backstage.io/kubernetes-resource-api-version':
          'api.kagent.dev/v1alpha3',
        'terasky.backstage.io/kubernetes-resource-namespace': 'kagent',
        'backstage.io/kubernetes-namespace': 'kagent',
        ...(overrides.annotations ?? {}),
      },
    },
    spec: { type: 'kagent-agent', ...(overrides.spec ?? {}) },
  };
}
