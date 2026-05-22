/**
 * Custom Scaffolder Action: kagent:agent:invoke
 * ==============================================
 *
 * Synchronously invokes a kagent.dev Agent via the A2A protocol. Now a thin
 * orchestrator over the kagent-shared library (resolver + invoker + input
 * validation). The shared library is the single source of truth for the
 * wire format and contract validation.
 *
 * IMPORTANT: agent responses are untrusted text. Templates that interpolate
 * the response into shell commands, file paths, or anything executable MUST
 * treat it as adversarial input.
 *
 * Companion spec: docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { DiscoveryService } from '@backstage/backend-plugin-api';
import {
  AgentInvocationError,
  invokeAgent,
  resolveAgent,
  validateInvokeInput,
} from '../kagent-shared';

// Re-export so any existing imports of AgentInvocationError from this module
// continue to work.
export { AgentInvocationError };

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
      const inputs = validateInvokeInput(ctx.input);
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
