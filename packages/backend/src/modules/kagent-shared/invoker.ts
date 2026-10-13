import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { AgentInvocationError } from './errors';

export interface InvokeOptions {
  timeoutMs: number;
  /** JSON-RPC request id (the scaffolder task id, or a per-request id). */
  stepId: string;
  /**
   * Caller identity for the kagent controller. In kagent's default
   * `insecure` auth mode the controller trusts the X-User-Id header and
   * makes that user the owner of the Session the call creates.
   */
  userId?: string;
  /**
   * Projected service account token file. When set it wins over userId: the
   * request carries `Authorization: Bearer <token>` and no X-User-Id, and the
   * service mesh in front of the controller sets the identity from the verified
   * token (system:serviceaccount:<ns>:<name>). Read on every call.
   */
  tokenFile?: string;
}


function readToken(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (e) {
    throw new AgentInvocationError(
      'ENDPOINT_UNREACHABLE',
      `cannot read the kagent token file ${file}: ${(e as Error).message}`,
    );
  }
}

/**
 * Identity the portal sends as X-User-Id. A dedicated id (rather than the
 * controller's `admin@kagent.dev` default) keeps the portal's one-shot,
 * machine-generated Sessions out of the operator's kagent UI history and
 * makes them attributable in the agent audit. DNS-label shaped on purpose:
 * it is an opaque string to kagent, but nothing downstream has to escape it.
 */
export const DEFAULT_A2A_USER_ID = 'backstage-portal';

// The gateway rejects a send it never dispatched with JSON-RPC -32004
// (UnsupportedOperation) plus an ErrorInfo whose metadata.reason is this value.
// It is the ONLY error kagent documents as safe to retry with the same message
// (docs/architecture/a2a-gateway.md, kagent v1.0.0-alpha11).
const SEND_NOT_ACCEPTED_REASON = 'KAGENT_SEND_NOT_ACCEPTED';
const UNSUPPORTED_OPERATION_CODE = -32004;
// Same bound as kagent's own e2e retry helper (go/core/test/e2e/a2a_http_test.go).
const SEND_NOT_ACCEPTED_BUDGET_MS = 30_000;

const FAILED_STATES = new Set([
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_CANCELED',
]);
const PAUSED_STATES = new Set([
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

// Errors raised before the request reached the controller. ECONNRESET can
// happen after it did, but every send here is an initial send (no contextId),
// and the gateway de-duplicates those by (caller, Agent, messageId): a retry
// with the same messageId reuses the conversation instead of running twice.
const NETWORK_ERROR_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
];

/** Concatenates text parts. A2A v1 parts are `{text}` / `{data}` / `{url}` / `{raw}`. */
function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(p => p && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('');
}

function normalizeState(state: unknown): string {
  const s = String(state ?? '').toUpperCase();
  return s.startsWith('TASK_STATE_') ? s : `TASK_STATE_${s}`;
}

/**
 * The answer text of a SendMessage result, mirroring kagent's own CLI
 * (`sendResultText` in go/core/cli/internal/commands/session/invoke.go):
 * the status message's text, then each artifact's text, one group per line.
 * Data parts (tool calls and tool results) are not answer text.
 */
export function resultText(result: any): string {
  if (result?.message) return partsText(result.message.parts);
  const task = result?.task;
  if (!task) return '';
  const groups = [partsText(task.status?.message?.parts)];
  for (const artifact of task.artifacts ?? []) {
    groups.push(partsText(artifact?.parts));
  }
  return groups.filter(g => g !== '').join('\n');
}

/** Delay before retrying a not-accepted send, or undefined if not retryable. */
export function sendNotAcceptedDelayMs(error: any): number | undefined {
  if (error?.code !== UNSUPPORTED_OPERATION_CODE) return undefined;
  // a2a-go sends `data` as a list of typed details; accept a lone object too.
  const details: any[] = [error.data].flat().filter(Boolean);
  for (const detail of details) {
    const metadata = detail?.metadata;
    if (metadata?.reason === SEND_NOT_ACCEPTED_REASON) {
      const hinted = Number(metadata.retryAfterMs);
      return Number.isFinite(hinted) && hinted > 0 ? hinted : 100;
    }
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      },
      { once: true },
    );
  });
}

/** Turns a SendMessage result into answer text, or throws for non-answers. */
function answerFrom(result: any): string {
  if (result?.message) return resultText(result);
  const task = result?.task;
  if (!task) {
    throw new AgentInvocationError(
      'AGENT_ERROR',
      'kagent returned a JSON-RPC result with neither a task nor a message.',
    );
  }
  const state = normalizeState(task.status?.state);
  const statusText = partsText(task.status?.message?.parts);
  if (FAILED_STATES.has(state)) {
    throw new AgentInvocationError(
      'AGENT_ERROR',
      `Agent task ended in ${state}${statusText ? `: ${statusText}` : ''}`,
    );
  }
  if (PAUSED_STATES.has(state)) {
    throw new AgentInvocationError(
      'AGENT_ERROR',
      `Agent paused in ${state} (an approval or question); the portal cannot answer it. ` +
        `Continue Session ${task.contextId ?? '?'} in the kagent UI.`,
    );
  }
  if (state !== 'TASK_STATE_COMPLETED') {
    throw new AgentInvocationError(
      'AGENT_ERROR',
      `Agent task returned before reaching a final state: ${state}`,
    );
  }
  return resultText(result);
}

/**
 * Invoke a kagent 1.0 Agent through the controller's A2A gateway
 * (`POST <controller>/agents/<namespace>/<name>`), A2A v1 JSON-RPC
 * `SendMessage`. Wire format per kagent v1.0.0-alpha11
 * docs/architecture/a2a-transports.md and a2a-go v2.6.0:
 *   - request:  role "ROLE_USER", parts [{text}], header A2A-Version: 1.0
 *   - response: result.task {id, contextId, status{state: TASK_STATE_*,
 *     message}, artifacts[{parts}]} or result.message
 * No contextId is sent, so every call starts a new Session; the call blocks
 * until the task is completed, failed or paused.
 */
export async function invokeAgent(
  endpoint: string,
  prompt: string,
  opts: InvokeOptions,
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void },
): Promise<string> {
  // Built once: every retry must resend the identical message (same
  // messageId), which is what makes retries safe on the gateway.
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: opts.stepId,
    method: 'SendMessage',
    params: {
      message: {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: prompt }],
      },
    },
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'A2A-Version': '1.0',
  };
  if (opts.tokenFile) {
    headers.Authorization = `Bearer ${readToken(opts.tokenFile)}`;
  } else {
    headers['X-User-Id'] = opts.userId ?? DEFAULT_A2A_USER_ID;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const notAcceptedDeadline = Date.now() + SEND_NOT_ACCEPTED_BUDGET_MS;
  let networkRetried = false;
  // Delay before the next attempt. Slept inside the try below so that a
  // timeout during the wait still surfaces as INVOCATION_TIMEOUT.
  let retryDelayMs = 0;

  logger.info(
    `kagent:agent:invoke — POST ${endpoint} (prompt: ${prompt.length} chars)`,
  );

  try {
    for (;;) {
      try {
        if (retryDelayMs > 0) {
          await sleep(retryDelayMs, controller.signal);
          retryDelayMs = 0;
        }
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new AgentInvocationError(
            'AGENT_ERROR',
            `kagent controller returned HTTP ${response.status}.`,
          );
        }

        const payload: any = await response.json();

        if (payload?.error) {
          const delay = sendNotAcceptedDelayMs(payload.error);
          if (delay !== undefined && Date.now() + delay < notAcceptedDeadline) {
            logger.warn(
              `kagent:agent:invoke — send not accepted yet (session busy); retrying in ${delay}ms`,
            );
            retryDelayMs = delay;
            continue;
          }
          throw new AgentInvocationError(
            'AGENT_ERROR',
            `Agent JSON-RPC error: ${payload.error.code} ${
              payload.error.message ?? ''
            }`.trim(),
          );
        }

        return answerFrom(payload?.result);
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
        if (!NETWORK_ERROR_CODES.includes(code)) {
          throw e;
        }
        if (networkRetried) {
          throw new AgentInvocationError(
            'ENDPOINT_UNREACHABLE',
            `Network error after retry: ${code}`,
          );
        }
        networkRetried = true;
        logger.warn(
          `kagent:agent:invoke — retrying after network error: ${code}`,
        );
        retryDelayMs = 500;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
