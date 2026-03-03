/**
 * Custom Scaffolder Action: vault:setup
 * =======================================
 *
 * Provisions Vault resources for a new CrewAI agent project. This action
 * automates what was previously a manual post-merge step: creating the Vault
 * policy, Kubernetes auth role, and placeholder secrets.
 *
 * HOW IT WORKS:
 * 1. Creates a read-only ACL policy for the project's secret path
 * 2. Creates a K8s auth role binding the namespace's ServiceAccount to the policy
 * 3. Seeds placeholder secrets so ExternalSecrets can sync immediately
 *
 * AUTHENTICATION:
 * Uses VAULT_ADDR and VAULT_TOKEN from environment variables. The token needs
 * permissions to manage policies, K8s auth roles, and KV secrets.
 *
 * IDEMPOTENCY:
 * All Vault API calls are create-or-update (PUT/POST). Running this action
 * multiple times with the same inputs produces the same result — existing
 * resources are overwritten with identical values.
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

/**
 * Helper: make an authenticated request to the Vault HTTP API.
 * Throws descriptive errors with troubleshooting hints on failure.
 */
async function vaultRequest(
  vaultAddr: string,
  vaultToken: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
  logger: { info: (msg: string) => void },
): Promise<void> {
  const url = `${vaultAddr}/v1/${path}`;
  logger.info(`vault:setup — ${method} ${url}`);

  const response = await fetch(url, {
    method,
    headers: {
      'X-Vault-Token': vaultToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(
      `vault:setup — Vault API error: ${method} ${path} returned ${response.status}: ${text}. ` +
        'Verify that VAULT_TOKEN has permissions to manage policies, ' +
        'auth/kubernetes/role/*, and k8s-secrets/data/*.',
    );
  }
}

/**
 * Creates the vault:setup scaffolder action.
 *
 * Inputs:
 *   - vaultRole (required): Vault role name (also used for policy and secret path)
 *   - namespace (required): K8s namespace for ServiceAccount binding
 *   - enableKnowledge (optional): If true, seeds an openai-api-key placeholder
 *   - serviceAccountNames (optional): Comma-separated SA names, defaults to "default"
 *
 * Outputs:
 *   - policyName: The created Vault policy name
 *   - roleName: The created Vault K8s auth role name
 *   - secretPath: The Vault KV path where secrets are stored
 */
export function createVaultSetupAction() {
  return createTemplateAction<
    {
      vaultRole: string;
      namespace: string;
      enableKnowledge?: boolean;
      serviceAccountNames?: string;
    },
    {
      policyName: string;
      roleName: string;
      secretPath: string;
    }
  >({
    id: 'vault:setup',
    description:
      'Creates a Vault policy, Kubernetes auth role, and placeholder secrets for a new project',
    schema: {
      input: {
        vaultRole: z =>
          z
            .string()
            .describe(
              'Vault role name — also used as the policy prefix and KV secret path',
            ),
        namespace: z =>
          z
            .string()
            .describe(
              'Kubernetes namespace where the ServiceAccount is located',
            ),
        enableKnowledge: z =>
          z
            .boolean()
            .optional()
            .default(false)
            .describe(
              'If true, seeds an openai-api-key placeholder for RAG embeddings',
            ),
        serviceAccountNames: z =>
          z
            .string()
            .optional()
            .default('default')
            .describe(
              'Comma-separated ServiceAccount names bound to the Vault role',
            ),
      },
      output: {
        policyName: z =>
          z.string().describe('Name of the created Vault policy'),
        roleName: z =>
          z.string().describe('Name of the created Vault K8s auth role'),
        secretPath: z =>
          z.string().describe('Vault KV path where secrets are stored'),
      },
    },
    async handler(ctx) {
      const {
        vaultRole,
        namespace,
        enableKnowledge = false,
        serviceAccountNames = 'default',
      } = ctx.input;

      // Validate required environment variables
      const vaultAddr = process.env.VAULT_ADDR;
      const vaultToken = process.env.VAULT_TOKEN;

      if (!vaultAddr) {
        throw new Error(
          'vault:setup — VAULT_ADDR environment variable is not set. ' +
            'Set it to your Vault server URL (e.g. http://vault.vault.svc.cluster.local:8200).',
        );
      }
      if (!vaultToken) {
        throw new Error(
          'vault:setup — VAULT_TOKEN environment variable is not set. ' +
            'Set it to a Vault token with permissions to manage policies, roles, and secrets.',
        );
      }

      const policyName = `${vaultRole}-read`;
      const roleName = vaultRole;
      const secretPath = `k8s-secrets/data/${vaultRole}`;

      ctx.logger.info(
        `vault:setup — Provisioning Vault resources for role="${vaultRole}" in namespace="${namespace}"`,
      );

      // ------------------------------------------------------------------
      // Step 1: Create ACL policy
      // ------------------------------------------------------------------
      // Grants read access to the project's KV data and metadata paths.
      // The metadata path is needed for ESO to check secret existence.
      const policyHcl = [
        `path "${secretPath}" {`,
        `  capabilities = ["read"]`,
        `}`,
        ``,
        `path "k8s-secrets/metadata/${vaultRole}" {`,
        `  capabilities = ["read"]`,
        `}`,
      ].join('\n');

      await vaultRequest(
        vaultAddr,
        vaultToken,
        'PUT',
        `sys/policies/acl/${policyName}`,
        { policy: policyHcl },
        ctx.logger,
      );
      ctx.logger.info(`vault:setup — Created policy: ${policyName}`);

      // ------------------------------------------------------------------
      // Step 2: Create K8s auth role
      // ------------------------------------------------------------------
      // Binds the specified ServiceAccount(s) in the target namespace to
      // the policy. This lets pods authenticate with Vault using their SA token.
      const saNames = serviceAccountNames
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      await vaultRequest(
        vaultAddr,
        vaultToken,
        'POST',
        `auth/kubernetes/role/${roleName}`,
        {
          bound_service_account_names: saNames,
          bound_service_account_namespaces: [namespace],
          policies: [policyName],
          ttl: '1h',
        },
        ctx.logger,
      );
      ctx.logger.info(
        `vault:setup — Created K8s auth role: ${roleName} (SA: ${saNames.join(', ')} in ${namespace})`,
      );

      // ------------------------------------------------------------------
      // Step 3: Seed placeholder secrets
      // ------------------------------------------------------------------
      // Writes placeholder values so ExternalSecrets can sync immediately
      // after the K8s manifests are deployed. Users replace these with real
      // values after initial deployment.
      const secretData: Record<string, string> = {
        'anthropic-api-key': 'PLACEHOLDER_REPLACE_ME',
        'api-keys': 'PLACEHOLDER_REPLACE_ME',
      };

      if (enableKnowledge) {
        secretData['openai-api-key'] = 'PLACEHOLDER_REPLACE_ME';
      }

      await vaultRequest(
        vaultAddr,
        vaultToken,
        'POST',
        secretPath,
        { data: secretData },
        ctx.logger,
      );
      ctx.logger.info(
        `vault:setup — Seeded placeholder secrets at ${secretPath} (keys: ${Object.keys(secretData).join(', ')})`,
      );

      // Set outputs for downstream steps and template output section
      ctx.output('policyName', policyName);
      ctx.output('roleName', roleName);
      ctx.output('secretPath', secretPath);

      ctx.logger.info(
        `vault:setup — Done. Policy: ${policyName}, Role: ${roleName}, Path: ${secretPath}`,
      );
    },
  });
}
