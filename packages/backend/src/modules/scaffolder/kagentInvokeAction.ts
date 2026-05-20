/**
 * Custom Scaffolder Action: kagent:agent:invoke
 * ==============================================
 *
 * Synchronously invokes a kagent.dev Agent via the A2A protocol. Discovery
 * uses the agents.platform.ai/* v1 annotation contract on the auto-ingested
 * catalog entity. Designed to be called from any Backstage scaffolder
 * template — e.g., a "suggest skills" wizard step.
 *
 * IMPORTANT: agent responses are untrusted text. Templates that interpolate
 * the response into shell commands, file paths, or anything executable MUST
 * treat it as adversarial input.
 *
 * Companion spec: docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { DiscoveryService } from '@backstage/backend-plugin-api';
import { randomUUID } from 'crypto';

export class AgentInvocationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AgentInvocationError';
  }
}

interface EndpointInfo {
  endpoint: string;
  runtime: string;
  contractVersion: string;
}

async function resolveAgent(
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
    // Validate URL format.
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

interface InvokeOptions {
  timeoutMs: number;
  stepId: string;
}

/**
 * Invoke a kagent agent via the A2A protocol.
 *
 * Wire format pinned by the live probe in
 * docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md
 * (A2A Probe Findings section). Three deltas from the upstream A2A spec:
 *   1. `params.message.messageId` is REQUIRED — agent returns -32602 without it
 *   2. Response text lives at `.result.artifacts[].parts[].text`
 *   3. Response parts use `kind: "text"` (input uses `type: "text"`)
 */
async function invokeAgent(
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

    // Defensive — the loop body always throws on its second iteration.
    throw new AgentInvocationError(
      'ENDPOINT_UNREACHABLE',
      'Retries exhausted',
    );
  } finally {
    clearTimeout(timer);
  }
}

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
      const raw = ctx.input as Record<string, unknown>;

      // Runtime input validation. The schema declared in `createTemplateAction`
      // drives the wizard UI form generator but does NOT enforce at handler
      // call time, so we re-validate here. Mirrors the spec's input contract.
      if (
        typeof raw.name !== 'string' ||
        !/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/.test(raw.name)
      ) {
        throw new Error(
          `kagent:agent:invoke: invalid agent name '${String(raw.name)}'. Must match ^[a-z][a-z0-9-]{2,38}[a-z0-9]$.`,
        );
      }
      if (
        typeof raw.prompt !== 'string' ||
        raw.prompt.length < 1 ||
        raw.prompt.length > 8000
      ) {
        throw new Error(
          `kagent:agent:invoke: invalid prompt length (${
            typeof raw.prompt === 'string' ? raw.prompt.length : 'not a string'
          }). Must be 1..8000 chars.`,
        );
      }
      if (raw.timeoutMs !== undefined) {
        if (
          typeof raw.timeoutMs !== 'number' ||
          !Number.isInteger(raw.timeoutMs) ||
          raw.timeoutMs < 5000 ||
          raw.timeoutMs > 300000
        ) {
          throw new Error(
            `kagent:agent:invoke: invalid timeoutMs ${String(raw.timeoutMs)}. Must be an integer in 5000..300000.`,
          );
        }
      }
      if (
        raw.onError !== undefined &&
        raw.onError !== 'fail' &&
        raw.onError !== 'continue'
      ) {
        throw new Error(
          `kagent:agent:invoke: invalid onError '${String(raw.onError)}'. Must be 'fail' or 'continue'.`,
        );
      }
      if (raw.expectJson !== undefined && typeof raw.expectJson !== 'boolean') {
        throw new Error(
          `kagent:agent:invoke: invalid expectJson type (${typeof raw.expectJson}). Must be boolean.`,
        );
      }

      const inputs = {
        name: raw.name,
        prompt: raw.prompt,
        expectJson: raw.expectJson as boolean | undefined,
        timeoutMs: raw.timeoutMs as number | undefined,
        onError: raw.onError as 'fail' | 'continue' | undefined,
      };
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
