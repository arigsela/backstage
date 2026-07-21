/**
 * Custom Scaffolder Action: newapp:validate-name
 * ===============================================
 * Fails the New Application wizard if base-apps/<name> already exists (as a
 * directory OR an Argo Application file base-apps/<name>.yaml), before
 * publish:github:pull-request would merge into / overwrite an existing app.
 * Reads process.env.GITHUB_TOKEN (same token as the other Octokit actions).
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Octokit } from '@octokit/rest';

const OWNER = 'arigsela';
const REPO = 'kubernetes';

function isHttpError(err: unknown): err is { status: number; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as any).status === 'number'
  );
}

async function pathExists(octokit: Octokit, path: string): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner: OWNER, repo: REPO, path });
    return true;
  } catch (err) {
    if (isHttpError(err) && err.status === 404) {
      return false;
    }
    throw err;
  }
}

export function createNewAppValidateNameAction() {
  return createTemplateAction({
    id: 'newapp:validate-name',
    description:
      'Fails if base-apps/<name> already exists (directory or base-apps/<name>.yaml Argo app).',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
            .describe('Proposed application name (kebab-case).'),
      },
    },
    async handler(ctx) {
      const { name } = ctx.input as { name: string };

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error(
          'GITHUB_TOKEN env var is not set. Required for newapp:validate-name.',
        );
      }

      const octokit = new Octokit({ auth: token });
      const dirPath = `base-apps/${name}`;
      const appPath = `base-apps/${name}.yaml`;

      ctx.logger.info(`newapp:validate-name — checking for collisions on '${name}'`);

      if (await pathExists(octokit, dirPath)) {
        throw new Error(
          `Application '${name}' already exists at ${dirPath}. Choose a different name.`,
        );
      }
      if (await pathExists(octokit, appPath)) {
        throw new Error(
          `Application '${name}' already exists at ${appPath}. Choose a different name.`,
        );
      }

      ctx.logger.info(`newapp:validate-name — name '${name}' is available.`);
    },
  });
}
