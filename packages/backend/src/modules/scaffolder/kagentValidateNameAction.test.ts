/**
 * Unit tests for kagent:agent:validate-name action.
 *
 * Tests use jest.mock('@octokit/rest') to mock the Octokit client.
 * ActionContext is mocked manually (createMockActionContext is not exported
 * by @backstage/plugin-scaffolder-node@0.12.5).
 *
 * Test cases:
 *   1. happy_path_name_available
 *   2. name_collides_in_agents_subdir
 *   3. name_collides_at_top_level (build-orchestrator collision)
 *   4. missing_github_token_throws
 */

import { createKagentValidateNameAction } from './kagentValidateNameAction';

jest.mock('@octokit/rest');
import { Octokit } from '@octokit/rest';

const MockedOctokit = Octokit as jest.MockedClass<typeof Octokit>;

function buildMockOctokit() {
  return {
    repos: {
      getContent: jest.fn(),
    },
  } as any;
}

function createMockActionContext(opts: { input: Record<string, unknown> }) {
  return {
    input: opts.input,
    output: jest.fn(),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    },
    workspacePath: '/tmp/test-workspace',
    checkpoint: jest.fn(),
    createTemporaryDirectory: jest.fn().mockResolvedValue('/tmp/test-temp'),
    getInitiatorCredentials: jest.fn(),
    task: { id: 'test-task-id' },
  } as any;
}

describe('kagent:agent:validate-name', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'fake-test-token';
    MockedOctokit.mockClear();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('happy_path_name_available: both lookups 404, no error', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent
      .mockRejectedValueOnce({ status: 404 })
      .mockRejectedValueOnce({ status: 404 });

    const ctx = createMockActionContext({ input: { name: 'release-coordinator' } });
    const action = createKagentValidateNameAction();
    await action.handler(ctx);

    expect(mock.repos.getContent).toHaveBeenCalledTimes(2);
    expect(mock.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'base-apps/kagent/release-coordinator.yaml' }),
    );
    expect(mock.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'base-apps/kagent/agents/release-coordinator.yaml' }),
    );
  });

  it('name_collides_in_agents_subdir: throws with clear error', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { sha: 'existing-sha' } });

    const ctx = createMockActionContext({ input: { name: 'duplicate-agent' } });
    const action = createKagentValidateNameAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      "Agent 'duplicate-agent' already exists at base-apps/kagent/agents/duplicate-agent.yaml. Choose a different name.",
    );
  });

  it('name_collides_at_top_level: throws with clear error', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent.mockResolvedValueOnce({ data: { sha: 'existing-sha' } });

    const ctx = createMockActionContext({ input: { name: 'build-orchestrator' } });
    const action = createKagentValidateNameAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      "Agent 'build-orchestrator' already exists at base-apps/kagent/build-orchestrator.yaml. Choose a different name.",
    );
  });

  it('missing_github_token_throws: clear operator-facing error', async () => {
    delete process.env.GITHUB_TOKEN;

    const ctx = createMockActionContext({ input: { name: 'foo' } });
    const action = createKagentValidateNameAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      'GITHUB_TOKEN env var is not set. Required for kagent:agent:validate-name.',
    );
  });
});
