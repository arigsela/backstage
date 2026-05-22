/**
 * Custom Scaffolder Action: kagent:mcp-server:validate-name
 * ==========================================================
 *
 * Validates that the proposed kagent MCPServer name does not collide with an
 * existing resource at either:
 *   - base-apps/kagent/mcp-servers/<name>/         (folder for IDP-managed servers)
 *   - base-apps/kagent/mcp-servers/<name>.yaml     (legacy/manual files)
 *
 * Throws with a clear error if either exists. Fails the wizard before
 * publish:github:pull-request would conflict.
 *
 * AUTHENTICATION:
 * Reads process.env.GITHUB_TOKEN. Same token used by other Octokit actions.
 *
 * Companion spec: docs/superpowers/specs/2026-05-22-kagent-mcp-server-template-design.md
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { Octokit } from '@octokit/rest';

const OWNER = 'arigsela';
const REPO = 'kubernetes';
const MCP_SERVERS_DIR = 'base-apps/kagent/mcp-servers';

function isHttpError(err: unknown): err is { status: number; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as any).status === 'number'
  );
}

// Returns true for both files and folders — getContent 200s on either
// (file = object response, folder = array response) and 404s when absent.
// The collision check needs both shapes since IDP-managed MCP servers
// live in a folder while legacy ones may exist as a single .yaml file.
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

export function createKagentMcpServerValidateNameAction() {
  return createTemplateAction({
    id: 'kagent:mcp-server:validate-name',
    description:
      'Fails if a kagent MCPServer with the given name already exists at either base-apps/kagent/mcp-servers/<name>/ or base-apps/kagent/mcp-servers/<name>.yaml.',
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z][a-z0-9-]{2,38}[a-z0-9]$/)
            .describe(
              'Proposed kagent MCPServer name (lowercase, hyphens, 4-40 chars).',
            ),
      },
    },

    async handler(ctx) {
      const { name } = ctx.input as { name: string };

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error(
          'GITHUB_TOKEN env var is not set. Required for kagent:mcp-server:validate-name.',
        );
      }

      const octokit = new Octokit({ auth: token });
      const folderPath = `${MCP_SERVERS_DIR}/${name}`;
      const legacyFilePath = `${MCP_SERVERS_DIR}/${name}.yaml`;

      ctx.logger.info(
        `kagent:mcp-server:validate-name — Checking for collisions on '${name}'`,
      );

      if (await pathExists(octokit, folderPath)) {
        throw new Error(
          `MCPServer '${name}' already exists at ${folderPath}/. Choose a different name.`,
        );
      }

      if (await pathExists(octokit, legacyFilePath)) {
        throw new Error(
          `MCPServer '${name}' already exists at ${legacyFilePath}. Choose a different name.`,
        );
      }

      ctx.logger.info(
        `kagent:mcp-server:validate-name — Name '${name}' is available.`,
      );
    },
  });
}
