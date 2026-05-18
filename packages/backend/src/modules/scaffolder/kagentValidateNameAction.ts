/**
 * Custom Scaffolder Action: kagent:agent:validate-name
 * =====================================================
 *
 * Validates that the proposed kagent Agent name does not collide with an
 * existing file at either:
 *   - base-apps/kagent/<name>.yaml         (hand-crafted agents, e.g. build-orchestrator)
 *   - base-apps/kagent/agents/<name>.yaml  (prior IDP-created agents)
 *
 * Throws with a clear error if either file exists. This fails the wizard
 * before publish:github:pull-request would conflict, giving a much better UX.
 *
 * AUTHENTICATION:
 * Reads process.env.GITHUB_TOKEN. Same token used by other Octokit actions.
 *
 * Companion spec: docs/superpowers/specs/2026-05-18-kagent-idp-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Octokit } from '@octokit/rest';

const OWNER = 'arigsela';
const REPO = 'kubernetes';
const TOP_LEVEL_DIR = 'base-apps/kagent';
const AGENTS_DIR = 'base-apps/kagent/agents';

function isHttpError(err: unknown): err is { status: number; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as any).status === 'number'
  );
}

async function fileExists(octokit: Octokit, path: string): Promise<boolean> {
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

export function createKagentValidateNameAction() {
  return createTemplateAction({
    id: 'kagent:agent:validate-name',
    description:
      'Fails if a kagent Agent with the given name already exists at either base-apps/kagent/<name>.yaml or base-apps/kagent/agents/<name>.yaml.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/)
            .describe(
              'Proposed kagent Agent name (lowercase, hyphens, 4-40 chars).',
            ),
      },
    },

    async handler(ctx) {
      const { name } = ctx.input as { name: string };

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error(
          'GITHUB_TOKEN env var is not set. Required for kagent:agent:validate-name.',
        );
      }

      const octokit = new Octokit({ auth: token });
      const topLevelPath = `${TOP_LEVEL_DIR}/${name}.yaml`;
      const agentsPath = `${AGENTS_DIR}/${name}.yaml`;

      ctx.logger.info(
        `kagent:validate-name — Checking for collisions on '${name}'`,
      );

      if (await fileExists(octokit, topLevelPath)) {
        throw new Error(
          `Agent '${name}' already exists at ${topLevelPath}. Choose a different name.`,
        );
      }

      if (await fileExists(octokit, agentsPath)) {
        throw new Error(
          `Agent '${name}' already exists at ${agentsPath}. Choose a different name.`,
        );
      }

      ctx.logger.info(`kagent:validate-name — Name '${name}' is available.`);
    },
  });
}
