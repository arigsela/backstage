/**
 * Custom Scaffolder Action: publish:file
 * ========================================
 *
 * Writes the scaffolded template output to the local filesystem instead of
 * publishing to a remote Git repository. This is useful for:
 *
 *   - LOCAL TESTING: Verify template output before wiring up publish:github
 *   - DEBUGGING: Inspect the rendered files to check Nunjucks substitution
 *   - OFFLINE DEV: Scaffold projects without needing GitHub credentials
 *
 * HOW IT WORKS:
 * 1. The scaffolder's fetch:template step renders files into a temp workspace
 * 2. This action copies everything from that workspace to a local directory
 * 3. The output path is shown as a link on the success page
 *
 * WHY THIS ISN'T BUILT-IN:
 * Backstage only ships publish:github, publish:gitlab, etc. because the
 * intended workflow is template → Git repo → catalog registration.
 * For local testing, we need this custom action.
 *
 * PRODUCTION NOTE: Replace this with publish:github when ready for real use.
 * See the template.yaml comments for the publish:github configuration block.
 */

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { mkdir, cp } from 'node:fs/promises';

/**
 * Creates the publish:file scaffolder action.
 *
 * This action copies the scaffolder workspace (rendered template files)
 * to a specified local filesystem path.
 *
 * Input:
 *   - path (required): Absolute path where files should be written.
 *     Supports Nunjucks interpolation in template.yaml, e.g.:
 *     /tmp/backstage-scaffolder/${{ parameters.name }}
 *
 * Output:
 *   - resultsUrl: file:// URL to the output directory (shown on success page)
 *   - outputPath: The absolute filesystem path (for downstream steps)
 */
export function createPublishFileAction() {
  return createTemplateAction({
    id: 'publish:file',
    description:
      'Writes the scaffolded output to a local filesystem path (for testing)',
    schema: {
      input: {
        // The target directory on the local filesystem.
        // The directory is created if it doesn't exist.
        // If it already exists, files are overwritten.
        path: z =>
          z.string().describe('Absolute path to write the scaffolded output to'),
      },
      output: {
        // file:// URL for the success page link
        resultsUrl: z =>
          z.string().describe('A file:// URL to the output directory'),
        // Raw path for use by downstream template steps
        outputPath: z =>
          z.string().describe('The absolute filesystem path of the output'),
      },
    },
    async handler(ctx) {
      const outputPath = ctx.input.path;

      ctx.logger.info(`publish:file — Writing scaffolded output to: ${outputPath}`);

      // Ensure the target directory exists (mkdir -p equivalent)
      await mkdir(outputPath, { recursive: true });

      // Copy the entire scaffolder workspace to the target directory.
      // The workspace (ctx.workspacePath) contains all files rendered by
      // the fetch:template step — with Nunjucks variables already replaced.
      // Node.js 16.7+ supports fs.cp with recursive copy.
      await cp(ctx.workspacePath, outputPath, {
        recursive: true,
        force: true, // Overwrite existing files if re-running the template
      });

      ctx.logger.info(`publish:file — Successfully wrote files to: ${outputPath}`);

      // Set outputs so the template.yaml can reference them in the output section
      const resultsUrl = `file://${outputPath}`;
      ctx.output('resultsUrl', resultsUrl);
      ctx.output('outputPath', outputPath);
    },
  });
}
