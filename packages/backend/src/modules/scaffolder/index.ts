/**
 * Custom Scaffolder Actions Module
 * ==================================
 *
 * This module registers custom scaffolder actions with the Backstage backend.
 * It uses the New Backend System's extension point mechanism to add actions
 * to the scaffolder plugin.
 *
 * HOW IT WORKS:
 * 1. Backstage's scaffolder plugin exposes a `scaffolderActionsExtensionPoint`
 * 2. This module declares a dependency on that extension point
 * 3. During initialization, it creates custom actions and registers them
 * 4. The actions then appear in the scaffolder's available actions list
 *
 * REGISTERED ACTIONS:
 * - publish:file — Writes template output to local filesystem (for testing)
 * - aws:ecr:create — Creates ECR repositories for orchestrator + sub-agent images
 * - aws:ecr:build-push — Builds Docker images and pushes them to ECR
 */

import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createPublishFileAction } from './publishFileAction';
import { createEcrCreateAction } from './ecrCreateAction';
import { createEcrBuildPushAction } from './ecrBuildPushAction';

/**
 * Backend module that adds custom scaffolder actions.
 *
 * IMPORTANT: The `pluginId` MUST be 'scaffolder' — this tells the backend
 * system that this module extends the scaffolder plugin. If you use a different
 * pluginId, the extension point won't resolve and registration will fail.
 */
const scaffolderCustomActionsModule = createBackendModule({
  pluginId: 'scaffolder', // Extends the scaffolder plugin (must match exactly)
  moduleId: 'custom-actions', // Unique identifier for this module
  register({ registerInit }) {
    registerInit({
      deps: {
        // Request the scaffolder's extension point for registering actions.
        // The backend DI system ensures this module initializes AFTER the
        // scaffolder plugin, so the extension point is guaranteed to be ready.
        scaffolderActions: scaffolderActionsExtensionPoint,
      },
      async init({ scaffolderActions }) {
        // Create and register all custom actions.
        // Each action becomes available in template.yaml files as its `id`.
        scaffolderActions.addActions(
          createPublishFileAction(),
          createEcrCreateAction(),
          createEcrBuildPushAction(),
        );
      },
    });
  },
});

/**
 * Default export required by Backstage's backend.add(import(...)) pattern.
 * The dynamic import resolves to this module's default export, which the
 * backend system then registers as a BackendFeature.
 */
export default scaffolderCustomActionsModule;
