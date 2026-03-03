/**
 * Custom Scaffolder Action: aws:ecr:create
 * ==========================================
 *
 * Creates ECR (Elastic Container Registry) repositories for a CrewAI agent
 * project. Each project needs two repos: one for the orchestrator image and
 * one for the sub-agent image.
 *
 * HOW IT WORKS:
 * 1. Builds repository names from project + sub-agent names
 * 2. Calls AWS ECR CreateRepository for each repo
 * 3. If a repo already exists (RepositoryAlreadyExistsException), it fetches
 *    the existing URI and continues — making this action fully idempotent
 * 4. Enables scanOnPush and tags repos with CreatedBy: backstage-scaffolder
 * 5. Outputs repo URIs and AWS Console URLs for the template output section
 *
 * AUTHENTICATION:
 * Uses the default AWS credential chain (env vars, instance profile, IRSA).
 * In EKS, the Backstage ServiceAccount needs an IAM role via IRSA with:
 *   - ecr:CreateRepository
 *   - ecr:DescribeRepositories
 *   - ecr:TagResource
 *
 * IDEMPOTENCY:
 * Running this action twice with the same inputs produces the same result.
 * Existing repos are not modified — their URIs are returned as-is.
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  type CreateRepositoryCommandInput,
} from '@aws-sdk/client-ecr';

/**
 * Helper: create a single ECR repository, returning its URI.
 * If the repo already exists, fetches and returns the existing URI.
 */
async function ensureEcrRepo(
  client: ECRClient,
  repoName: string,
  registryId: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string> {
  const input: CreateRepositoryCommandInput = {
    repositoryName: repoName,
    registryId,
    // scanOnPush enables automatic vulnerability scanning on every push
    imageScanningConfiguration: { scanOnPush: true },
    // IMMUTABLE prevents overwriting an existing tag (safer for prod)
    // We use MUTABLE here because the template pushes :latest alongside versioned tags
    imageTagMutability: 'MUTABLE',
    tags: [
      { Key: 'CreatedBy', Value: 'backstage-scaffolder' },
      { Key: 'ManagedBy', Value: 'backstage' },
    ],
  };

  try {
    const result = await client.send(new CreateRepositoryCommand(input));
    const uri = result.repository?.repositoryUri ?? '';
    logger.info(`aws:ecr:create — Created repo: ${repoName} → ${uri}`);
    return uri;
  } catch (err: unknown) {
    // If the repo already exists, fetch its URI and continue (idempotent)
    if (
      err instanceof Error &&
      err.name === 'RepositoryAlreadyExistsException'
    ) {
      logger.warn(
        `aws:ecr:create — Repo already exists: ${repoName} — fetching URI`,
      );
      const desc = await client.send(
        new DescribeRepositoriesCommand({
          registryId,
          repositoryNames: [repoName],
        }),
      );
      return desc.repositories?.[0]?.repositoryUri ?? '';
    }
    // For any other error, re-throw with an IAM troubleshooting hint
    throw new Error(
      `aws:ecr:create — Failed to create repo "${repoName}": ${err instanceof Error ? err.message : String(err)}. ` +
        'Verify that the Backstage IAM role has ecr:CreateRepository, ' +
        'ecr:DescribeRepositories, and ecr:TagResource permissions.',
    );
  }
}

/**
 * Creates the aws:ecr:create scaffolder action.
 *
 * Inputs:
 *   - projectName (required): Base name for the ECR repos
 *   - subAgentName (required): Sub-agent name (used in the second repo name)
 *   - region (optional): AWS region, defaults to us-east-2
 *   - registryId (optional): AWS account ID for the ECR registry
 *
 * Outputs:
 *   - orchestratorRepoUri: Full URI for the orchestrator ECR repo
 *   - subAgentRepoUri: Full URI for the sub-agent ECR repo
 *   - orchestratorRepoName: Repo name (for use in docker build commands)
 *   - subAgentRepoName: Repo name (for use in docker build commands)
 *   - orchestratorConsoleUrl: AWS Console URL for the orchestrator repo
 *   - subAgentConsoleUrl: AWS Console URL for the sub-agent repo
 */
export function createEcrCreateAction() {
  return createTemplateAction({
    id: 'aws:ecr:create',
    description:
      'Creates ECR repositories for the orchestrator and sub-agent Docker images',
    schema: {
      input: {
        projectName: z =>
          z
            .string()
            .describe(
              'Project name — used as prefix for ECR repo names (e.g. "chores-knowledge-agent")',
            ),
        subAgentName: z =>
          z
            .string()
            .describe(
              'Sub-agent name — used as suffix for the sub-agent repo (e.g. "knowledge-agent")',
            ),
        region: z =>
          z
            .string()
            .optional()
            .default('us-east-2')
            .describe('AWS region for the ECR repositories'),
        registryId: z =>
          z
            .string()
            .optional()
            .default('852893458518')
            .describe('AWS account ID (ECR registry ID)'),
      },
      output: {
        orchestratorRepoUri: z =>
          z.string().describe('Full URI for the orchestrator ECR repo'),
        subAgentRepoUri: z =>
          z.string().describe('Full URI for the sub-agent ECR repo'),
        orchestratorRepoName: z =>
          z.string().describe('Orchestrator ECR repo name'),
        subAgentRepoName: z =>
          z.string().describe('Sub-agent ECR repo name'),
        orchestratorConsoleUrl: z =>
          z.string().describe('AWS Console URL for the orchestrator repo'),
        subAgentConsoleUrl: z =>
          z.string().describe('AWS Console URL for the sub-agent repo'),
      },
    },
    async handler(ctx) {
      const {
        projectName,
        subAgentName,
        region = 'us-east-2',
        registryId = '852893458518',
      } = ctx.input;

      // Build repo names: {project}-orchestrator and {project}-{subAgent}
      const orchestratorRepoName = `${projectName}-orchestrator`;
      const subAgentRepoName = `${projectName}-${subAgentName}`;

      ctx.logger.info(
        `aws:ecr:create — Creating ECR repos: ${orchestratorRepoName}, ${subAgentRepoName} in ${region}`,
      );

      // Create the ECR client using the default credential chain.
      // In EKS this uses IRSA; locally it uses ~/.aws/credentials or env vars.
      const client = new ECRClient({ region });

      // Create both repos (or fetch existing ones if they already exist)
      const orchestratorRepoUri = await ensureEcrRepo(
        client,
        orchestratorRepoName,
        registryId,
        ctx.logger,
      );
      const subAgentRepoUri = await ensureEcrRepo(
        client,
        subAgentRepoName,
        registryId,
        ctx.logger,
      );

      // Build AWS Console URLs for the output links
      const consoleBase = `https://${region}.console.aws.amazon.com/ecr/repositories/private/${registryId}`;
      const orchestratorConsoleUrl = `${consoleBase}/${orchestratorRepoName}`;
      const subAgentConsoleUrl = `${consoleBase}/${subAgentRepoName}`;

      // Set all outputs for downstream template steps and the output section
      ctx.output('orchestratorRepoUri', orchestratorRepoUri);
      ctx.output('subAgentRepoUri', subAgentRepoUri);
      ctx.output('orchestratorRepoName', orchestratorRepoName);
      ctx.output('subAgentRepoName', subAgentRepoName);
      ctx.output('orchestratorConsoleUrl', orchestratorConsoleUrl);
      ctx.output('subAgentConsoleUrl', subAgentConsoleUrl);

      ctx.logger.info(
        `aws:ecr:create — Done. Orchestrator: ${orchestratorRepoUri}, Sub-agent: ${subAgentRepoUri}`,
      );
    },
  });
}
