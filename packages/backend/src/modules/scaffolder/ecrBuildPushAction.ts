/**
 * Custom Scaffolder Action: aws:ecr:build-push
 * ===============================================
 *
 * Builds Docker images for a CrewAI agent project and pushes them to ECR.
 * This runs after aws:ecr:create has ensured the repos exist.
 *
 * HOW IT WORKS:
 * 1. Verifies Docker is available by running `docker version`
 * 2. Gets an ECR auth token via AWS SDK (GetAuthorizationTokenCommand)
 * 3. Logs into ECR via `docker login` with the token piped to stdin (secure)
 * 4. Builds each image with `docker buildx build --platform linux/amd64 --push`
 * 5. Tags each image with both :{version} and :latest
 *
 * BUILD CONTEXT:
 * The scaffolder workspace contains the rendered agent code at {agentCodePath}/.
 * Dockerfiles are at {agentCodePath}/docker/Dockerfile.orchestrator and
 * {agentCodePath}/docker/Dockerfile.{subAgentName}.
 *
 * SECURITY:
 * - ECR password is NEVER passed as a CLI argument (would appear in ps output)
 * - Instead, we pipe it to `docker login --password-stdin` via child_process.spawn
 * - Auth tokens are short-lived (12 hours) and scoped to the registry
 *
 * DOCKER AVAILABILITY:
 * - Local dev: Docker Desktop provides the daemon — works natively
 * - EKS production: Requires Docker socket mount or DinD sidecar
 *   (EKS 1.24+ uses containerd, no Docker socket by default)
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  ECRClient,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Helper: run a shell command and stream output to the scaffolder logger.
 * Uses execFile (not shell) to avoid injection risks.
 */
async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string },
  logger: { info: (msg: string) => void },
): Promise<void> {
  logger.info(`aws:ecr:build-push — Running: ${command} ${args.join(' ')}`);
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    // Docker builds can take a while — 10 minute timeout
    timeout: 600_000,
    maxBuffer: 50 * 1024 * 1024, // 50 MB buffer for Docker build output
  });
  if (stdout) logger.info(stdout);
  if (stderr) logger.info(stderr);
}

/**
 * Helper: log into ECR by piping the password to `docker login --password-stdin`.
 * This avoids putting the password in CLI args (which would be visible in `ps`).
 */
async function dockerLogin(
  registryUrl: string,
  password: string,
  logger: { info: (msg: string) => void },
): Promise<void> {
  logger.info(`aws:ecr:build-push — Logging into ECR: ${registryUrl}`);
  return new Promise((resolvePromise, reject) => {
    // Spawn docker login with --password-stdin so password comes from stdin pipe
    const proc = spawn('docker', ['login', '--username', 'AWS', '--password-stdin', registryUrl], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        logger.info(`aws:ecr:build-push — ECR login succeeded`);
        resolvePromise();
      } else {
        reject(
          new Error(
            `Docker login failed (exit ${code}): ${stderr || stdout}`,
          ),
        );
      }
    });

    proc.on('error', reject);

    // Write the password to stdin and close it
    proc.stdin.write(password);
    proc.stdin.end();
  });
}

/**
 * Creates the aws:ecr:build-push scaffolder action.
 *
 * Inputs:
 *   - projectName (required): Used to locate Dockerfiles and name images
 *   - subAgentName (required): Sub-agent identifier for Dockerfile and repo name
 *   - version (optional): Image tag version, defaults to "latest"
 *   - region (optional): AWS region, defaults to us-east-2
 *   - registryUrl (optional): ECR registry URL (auto-derived from region + account)
 *   - agentCodePath (optional): Path within workspace to agent code, defaults to "agent-code"
 *
 * Outputs:
 *   - orchestratorImage: Full image URI with version tag
 *   - subAgentImage: Full image URI with version tag
 */
export function createEcrBuildPushAction() {
  return createTemplateAction({
    id: 'aws:ecr:build-push',
    description:
      'Builds Docker images for orchestrator and sub-agent, then pushes to ECR',
    schema: {
      input: {
        projectName: z =>
          z
            .string()
            .describe('Project name — prefix for ECR repo names'),
        subAgentName: z =>
          z
            .string()
            .describe('Sub-agent name — used to find Dockerfile and repo'),
        version: z =>
          z
            .string()
            .optional()
            .default('latest')
            .describe('Image tag version (e.g. "1.0.0")'),
        region: z =>
          z
            .string()
            .optional()
            .default('us-east-2')
            .describe('AWS region for ECR'),
        registryUrl: z =>
          z
            .string()
            .optional()
            .describe(
              'ECR registry URL (e.g. 852893458518.dkr.ecr.us-east-2.amazonaws.com). Auto-derived if not provided.',
            ),
        agentCodePath: z =>
          z
            .string()
            .optional()
            .default('agent-code')
            .describe(
              'Subdirectory in the scaffolder workspace containing the agent code',
            ),
      },
      output: {
        orchestratorImage: z =>
          z
            .string()
            .describe('Full orchestrator image URI with version tag'),
        subAgentImage: z =>
          z
            .string()
            .describe('Full sub-agent image URI with version tag'),
      },
    },
    async handler(ctx) {
      const {
        projectName,
        subAgentName,
        version = 'latest',
        region = 'us-east-2',
        registryUrl: registryUrlInput,
        agentCodePath = 'agent-code',
      } = ctx.input;

      // --- Step 1: Verify Docker is available ---
      try {
        await execFileAsync('docker', ['version']);
        ctx.logger.info('aws:ecr:build-push — Docker daemon is available');
      } catch {
        throw new Error(
          'aws:ecr:build-push — Docker is not available. ' +
            'Local dev: ensure Docker Desktop is running. ' +
            'EKS: a DinD sidecar or Docker socket mount is required ' +
            '(EKS 1.24+ uses containerd by default, not Docker).',
        );
      }

      // --- Step 2: Get ECR auth token ---
      const ecrClient = new ECRClient({ region });
      const authResult = await ecrClient.send(
        new GetAuthorizationTokenCommand({}),
      );
      const authData = authResult.authorizationData?.[0];
      if (!authData?.authorizationToken || !authData?.proxyEndpoint) {
        throw new Error(
          'aws:ecr:build-push — Failed to get ECR authorization token. ' +
            'Verify IAM permissions include ecr:GetAuthorizationToken.',
        );
      }

      // The token is base64(username:password) — decode and extract password
      const decoded = Buffer.from(authData.authorizationToken, 'base64').toString('utf-8');
      const password = decoded.split(':')[1];
      // proxyEndpoint is https://ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
      const registryUrl =
        registryUrlInput ?? authData.proxyEndpoint.replace('https://', '');

      // --- Step 3: Docker login to ECR ---
      await dockerLogin(registryUrl, password, ctx.logger);

      // --- Step 4: Build and push images ---
      // The agent code is in a subdirectory of the scaffolder workspace
      const buildContext = resolve(ctx.workspacePath, agentCodePath);
      const orchestratorRepoName = `${projectName}-orchestrator`;
      const subAgentRepoName = `${projectName}-${subAgentName}`;

      // Build image specs: [repoName, dockerfilePath]
      const images: Array<{
        repoName: string;
        dockerfile: string;
        label: string;
      }> = [
        {
          repoName: orchestratorRepoName,
          dockerfile: `docker/Dockerfile.orchestrator`,
          label: 'orchestrator',
        },
        {
          repoName: subAgentRepoName,
          dockerfile: `docker/Dockerfile.${subAgentName}`,
          label: subAgentName,
        },
      ];

      const outputImages: Record<string, string> = {};

      for (const { repoName, dockerfile, label } of images) {
        const versionTag = `${registryUrl}/${repoName}:${version}`;
        const latestTag = `${registryUrl}/${repoName}:latest`;

        ctx.logger.info(
          `aws:ecr:build-push — Building ${label}: ${versionTag}`,
        );

        // Build with buildx for linux/amd64 (EKS nodes) and push in one step.
        // --push combines build+push, avoiding a separate docker push command.
        // --platform ensures we build for the target architecture regardless of
        // the host (important when building on Apple Silicon).
        const buildArgs = [
          'buildx', 'build',
          '--platform', 'linux/amd64',
          '--file', dockerfile,
          '--tag', versionTag,
          '--tag', latestTag,
          '--push',
          '.', // build context is the agent code directory
        ];

        await runCommand('docker', buildArgs, { cwd: buildContext }, ctx.logger);

        ctx.logger.info(
          `aws:ecr:build-push — Pushed ${label}: ${versionTag}`,
        );
        outputImages[label] = versionTag;
      }

      // --- Step 5: Set outputs ---
      const orchestratorImage = `${registryUrl}/${orchestratorRepoName}:${version}`;
      const subAgentImage = `${registryUrl}/${subAgentRepoName}:${version}`;

      ctx.output('orchestratorImage', orchestratorImage);
      ctx.output('subAgentImage', subAgentImage);

      ctx.logger.info(
        `aws:ecr:build-push — All images built and pushed successfully`,
      );
    },
  });
}
