/**
 * HTTP route handler for the kagent-suggest backend plugin.
 *
 * Exposes:  POST /invoke   (mounted at /api/kagent-suggest/invoke)
 *
 * Thin wrapper over the kagent-shared library — validates input (with a 120s
 * timeout cap), resolves the agent via the catalog, invokes via A2A, returns
 * the response as JSON. Always HTTP 200; failures communicated via
 * {ok: false, code, message} in the body so the frontend field can render
 * them inline.
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 */
import express, { Router } from 'express';
import type { DiscoveryService, LoggerService } from '@backstage/backend-plugin-api';
import {
  AgentInvocationError,
  invokeAgent,
  resolveAgent,
  tolerantParseJson,
  validateInvokeInput,
} from '../kagent-shared';

const MAX_TIMEOUT_MS = 120_000;

export async function createRouter(opts: {
  discovery: DiscoveryService;
  logger: LoggerService;
}): Promise<Router> {
  const { discovery, logger } = opts;
  const router = Router();

  // Explicit JSON body parser. Backstage's httpRouter normally provides one
  // globally, but in this codebase req.body arrives as undefined for our
  // plugin's routes — confirmed via diagnostic. Applying our own parser is
  // idempotent and removes the dependency on backend internals.
  router.use(express.json());

  router.post('/invoke', async (req, res) => {
    const startedAt = Date.now();

    logger.info(
      `kagent-suggest — received POST /invoke body keys=[${Object.keys(req.body ?? {}).join(',')}]`,
    );

    // 1. Input validation. The route caps timeout at 120s (vs the action's
    // 300s) because users are waiting interactively — anything longer is
    // beyond the threshold of "still feels interactive".
    let inputs;
    try {
      inputs = validateInvokeInput(
        {
          name: req.body?.agentName,
          prompt: req.body?.prompt,
          expectJson: req.body?.expectJson,
          timeoutMs: req.body?.timeoutMs,
        },
        { maxTimeoutMs: MAX_TIMEOUT_MS },
      );
    } catch (e: any) {
      logger.warn(`kagent-suggest — BAD_INPUT: ${e.message}`);
      res.status(200).json({
        ok: false,
        code: 'BAD_INPUT',
        message: e.message,
      });
      return;
    }

    const timeoutMs = inputs.timeoutMs ?? 60_000;
    const expectJson = inputs.expectJson ?? false;

    try {
      const info = await resolveAgent(discovery, inputs.name, logger);
      const text = await invokeAgent(
        info.endpoint,
        inputs.prompt,
        { timeoutMs, stepId: `kagent-suggest-${Date.now()}` },
        logger,
      );

      let response: unknown = text;
      if (expectJson) {
        try {
          response = tolerantParseJson(text);
        } catch (e: any) {
          logger.warn(
            `kagent-suggest — INVALID_RESPONSE_JSON from ${inputs.name}; raw response (first 500): ${text.slice(0, 500)}`,
          );
          res.status(200).json({
            ok: false,
            code: 'INVALID_RESPONSE_JSON',
            message: `Expected JSON response but parse failed: ${e.message}`,
          });
          return;
        }
      }

      const durationMs = Date.now() - startedAt;
      logger.info(
        `kagent-suggest — ok in ${durationMs}ms (agent=${inputs.name}, response length=${text.length})`,
      );

      res.status(200).json({
        ok: true,
        agentName: inputs.name,
        runtime: info.runtime,
        durationMs,
        response,
      });
    } catch (e: any) {
      const code = e instanceof AgentInvocationError ? e.code : 'AGENT_ERROR';
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`kagent-suggest — ${code}: ${message}`);
      res.status(200).json({
        ok: false,
        code,
        message,
      });
    }
  });

  return router;
}
