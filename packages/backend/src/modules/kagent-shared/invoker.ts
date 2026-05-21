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
