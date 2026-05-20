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
      const { name, prompt, onError } = ctx.input as {
        name: string;
        prompt: string;
        onError?: 'fail' | 'continue';
      };

      const startedAt = Date.now();

      try {
        const info = await resolveAgent(discovery, name, ctx.logger);

        // A2AClient call is wired in Task 4. For now, throw so the catalog
        // path is exercised end-to-end by the tests.
        void prompt;
        void info;
        throw new AgentInvocationError(
          'AGENT_ERROR',
          'A2A invocation not yet implemented (wired in Task 4).',
        );
      } catch (e: any) {
        const code = e instanceof AgentInvocationError ? e.code : 'AGENT_ERROR';
        const message = e instanceof Error ? e.message : String(e);

        if (onError === 'continue') {
          ctx.output('response', '');
          ctx.output('agentName', name);
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
