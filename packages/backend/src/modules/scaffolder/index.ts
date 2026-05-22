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
 * - kagent:agent:validate-name — Fails the wizard on kagent agent name collisions
 * - kagent:agent:open-decommission-pr — Opens a teardown PR for an IDP-managed kagent Agent
 * - kagent:agent:invoke — Synchronously calls a kagent.dev Agent via the A2A protocol
 */

import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createPublishFileAction } from './publishFileAction';
import { createEcrCreateAction } from './ecrCreateAction';
import { createEcrBuildPushAction } from './ecrBuildPushAction';
import { createVaultSetupAction } from './vaultSetupAction';
import { createDecommissionPullRequestAction } from './decommissionPullRequestAction';
import { createKagentValidateNameAction } from './kagentValidateNameAction';
import { createKagentDecommissionAction } from './kagentDecommissionAction';
import { createKagentInvokeAction } from './kagentInvokeAction';


const scaffolderCustomActionsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'custom-actions',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolderActions: scaffolderActionsExtensionPoint,
        // kagent:agent:invoke uses discovery to find the local catalog API.
        discovery: coreServices.discovery,
      },
      async init({ scaffolderActions, discovery }) {
        scaffolderActions.addActions(
          createPublishFileAction(),
          createEcrCreateAction(),
          createEcrBuildPushAction(),
          createVaultSetupAction(),
          createDecommissionPullRequestAction(),
          createKagentValidateNameAction(),
          createKagentDecommissionAction(),
          createKagentInvokeAction({ discovery }),
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
