/**
 * cve backend plugin
 * ===================
 *
 * Registers POST /report and GET /health, auto-mounted by Backstage at
 * /api/cve/ because the pluginId is 'cve'. Reads the weekly Trivy scan
 * reports from S3 and answers "what is wrong with the images this component
 * runs" for the entity-page card and Security tab.
 *
 * The plugin never talks to Kubernetes. The frontend resolves the entity's
 * running images via useKubernetesObjects and posts the list here.
 *
 * Companion spec: docs/superpowers/specs/2026-08-18-container-cve-surfacing-design.md
 */
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { readCveConfig } from './config';
import { createRouter } from './router';
import { ReportStore } from './reportStore';
import { createS3ReportSource } from './s3Client';

const cvePlugin = createBackendPlugin({
  pluginId: 'cve',
  register({ registerInit }) {
    registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ httpRouter, config, logger }) {
        const cfg = readCveConfig(config);
        const store = new ReportStore(createS3ReportSource(cfg), cfg);
        httpRouter.use(await createRouter({ store, logger }));
      },
    });
  },
});

export default cvePlugin;
