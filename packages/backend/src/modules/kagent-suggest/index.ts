/**
 * kagent-suggest backend plugin
 * ===============================
 *
 * Registers POST /invoke (auto-mounted by Backstage at /api/kagent-suggest/
 * because the pluginId is 'kagent-suggest'). Called by the KagentSuggest
 * frontend field during scaffolder wizard form-fill.
 *
 * Internally calls the kagent-shared library (resolver + invoker) — same
 * code path as the kagent:agent:invoke scaffolder action, just exposed
 * over HTTP for interactive use.
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 */
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { createRouter } from './router';

const kagentSuggestPlugin = createBackendPlugin({
  pluginId: 'kagent-suggest',
  register({ registerInit }) {
    registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        discovery: coreServices.discovery,
        logger: coreServices.logger,
      },
      async init({ httpRouter, discovery, logger }) {
        const router = await createRouter({ discovery, logger });
        httpRouter.use(router);
      },
    });
  },
});

export default kagentSuggestPlugin;
