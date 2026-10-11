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
 * over HTTP for interactive use. Since kagent 1.0 the call goes to the
 * kagent controller's A2A gateway (`/agents/<ns>/<name>`), not to a
 * per-agent Service.
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 */
import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { readKagentA2AConfig } from '../kagent-shared';
import { createRouter } from './router';

const kagentSuggestPlugin = createBackendPlugin({
  pluginId: 'kagent-suggest',
  register({ registerInit }) {
    registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        discovery: coreServices.discovery,
        logger: coreServices.logger,
        // Optional `kagent.a2aBaseUrl` / `kagent.a2aUserId` (see app-config.yaml).
        config: coreServices.rootConfig,
      },
      async init({ httpRouter, discovery, logger, config }) {
        const router = await createRouter({
          discovery,
          logger,
          a2a: readKagentA2AConfig(config),
        });
        httpRouter.use(router);
      },
    });
  },
});

export default kagentSuggestPlugin;
