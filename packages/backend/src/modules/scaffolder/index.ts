/**
 * Custom Scaffolder Actions Module
 * ==================================
 *
 * This module registers custom scaffolder actions with the Backstage backend.
 * It uses the New Backend System's extension point mechanism to add actions
 * to the scaffolder plugin.
 *
 * REGISTERED ACTIONS:
 * - publish:file — Writes template output to local filesystem (for testing)
 * - aws:ecr:create — Creates ECR repositories
 * - aws:ecr:build-push — Builds Docker images and pushes them to ECR (legacy)
 * - vault:setup — Creates Vault policy, K8s auth role, and placeholder secrets
 * - crossplane:teardown:open-decommission-pr — Opens a teardown PR for a v1.x IDP app
 * - newapp:validate-name — Fails the wizard on base-apps/<name> collisions
 * - kagent:agent:invoke — Synchronously calls a kagent.dev Agent via the A2A protocol
 *
 * kagent:agent:validate-name and kagent:agent:open-decommission-pr were removed
 * at the kagent 1.0 move: no template has used them since the kagent-agent
 * templates were deleted (commit 926fd35), and they hard-coded the 0.10
 * one-file-per-agent layout (1.0 splits an agent into Agent + AgentTemplate).
 */

import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createPublishFileAction } from './publishFileAction';
import { createEcrCreateAction } from './ecrCreateAction';
import { createEcrBuildPushAction } from './ecrBuildPushAction';
import { createVaultSetupAction } from './vaultSetupAction';
import { createDecommissionPullRequestAction } from './decommissionPullRequestAction';
import { createKagentInvokeAction } from './kagentInvokeAction';
import { readKagentA2AConfig } from '../kagent-shared';
import { createNewAppValidateNameAction } from './newAppValidateNameAction';


const scaffolderCustomActionsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'custom-actions',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolderActions: scaffolderActionsExtensionPoint,
        // kagent:agent:invoke uses discovery to find the local catalog API,
        // and the optional `kagent:` config block for the controller URL.
        discovery: coreServices.discovery,
        config: coreServices.rootConfig,
      },
      async init({ scaffolderActions, discovery, config }) {
        scaffolderActions.addActions(
          createPublishFileAction(),
          createEcrCreateAction(),
          createEcrBuildPushAction(),
          createVaultSetupAction(),
          createDecommissionPullRequestAction(),
          createNewAppValidateNameAction(),
          createKagentInvokeAction({ discovery, a2a: readKagentA2AConfig(config) }),
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
