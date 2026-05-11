/**
 * Unit tests for crossplane:teardown:open-decommission-pr action.
 *
 * Tests use jest.mock('@octokit/rest') to mock the Octokit client.
 * ActionContext is mocked manually (createMockActionContext is not exported
 * by @backstage/plugin-scaffolder-node@0.12.5 — the testUtils subpath
 * export was added in a later version).
 *
 * 7 test cases per spec §7:
 *   1. happy_path
 *   2. app_not_found_top_level_404
 *   3. directory_not_found_404_continues
 *   4. branch_already_exists_reuses
 *   5. pr_already_open_returns_existing
 *   6. pr_create_race_condition_422
 *   7. missing_github_token_throws
 */

import { createDecommissionPullRequestAction } from './decommissionPullRequestAction';

// Mock the entire @octokit/rest module
jest.mock('@octokit/rest');
import { Octokit } from '@octokit/rest';

// Type-cast the mocked Octokit constructor for jest.fn() typing
const MockedOctokit = Octokit as jest.MockedClass<typeof Octokit>;

/**
 * Helper: build a fully-mocked Octokit instance with all required methods
 * stubbed. Each test customizes individual methods via mockResolvedValue /
 * mockRejectedValue as needed.
 */
function buildMockOctokit() {
  return {
    repos: {
      getContent: jest.fn(),
      getBranch: jest.fn(),
      deleteFile: jest.fn(),
    },
    git: {
      getRef: jest.fn(),
      createRef: jest.fn(),
    },
    pulls: {
      list: jest.fn(),
      create: jest.fn(),
    },
  } as any;
}

/**
 * Helper: create a minimal mock ActionContext.
 * createMockActionContext is not available in @backstage/plugin-scaffolder-node@0.12.5
 * (testUtils subpath export was added in a later version), so we build it manually.
 */
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

describe('crossplane:teardown:open-decommission-pr', () => {
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

  it('happy_path: opens PR with 3 files deleted', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    // Top-level YAML exists
    mock.repos.getContent
      .mockResolvedValueOnce({ data: { sha: 'sha-toplevel' } })
      // Directory listing returns 2 files
      .mockResolvedValueOnce({ data: [{ path: 'base-apps/smoke-v141/application-xr.yaml' }, { path: 'base-apps/smoke-v141/aws-resources.yaml' }] })
      // SHA fetches for each file during delete loop
      .mockResolvedValueOnce({ data: { sha: 'sha-toplevel' } })
      .mockResolvedValueOnce({ data: { sha: 'sha-xr' } })
      .mockResolvedValueOnce({ data: { sha: 'sha-aws' } });

    // Branch doesn't exist yet
    mock.repos.getBranch.mockRejectedValueOnce({ status: 404 });
    mock.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'main-sha' } } });
    mock.git.createRef.mockResolvedValueOnce({});

    mock.repos.deleteFile.mockResolvedValue({});

    // No existing PR
    mock.pulls.list.mockResolvedValueOnce({ data: [] });
    mock.pulls.create.mockResolvedValueOnce({ data: { html_url: 'https://github.com/arigsela/kubernetes/pull/300', number: 300 } });

    const ctx = createMockActionContext({ input: { name: 'smoke-v141' } });
    const action = createDecommissionPullRequestAction();
    await action.handler(ctx);

    expect(mock.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: 'base-apps/smoke-v141.yaml' }));
    expect(mock.git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/chore/teardown-smoke-v141' }));
    expect(mock.repos.deleteFile).toHaveBeenCalledTimes(3);
    expect(mock.pulls.create).toHaveBeenCalledWith(expect.objectContaining({
      head: 'chore/teardown-smoke-v141',
      base: 'main',
      title: 'chore: tear down smoke-v141 (decommission)',
    }));
    expect(ctx.output).toHaveBeenCalledWith('remoteUrl', 'https://github.com/arigsela/kubernetes/pull/300');
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 300);
    expect(ctx.output).toHaveBeenCalledWith('branchName', 'chore/teardown-smoke-v141');
  });

  it('app_not_found_top_level_404: throws with clear error', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent.mockRejectedValueOnce({ status: 404 });

    const ctx = createMockActionContext({ input: { name: 'does-not-exist' } });
    const action = createDecommissionPullRequestAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      "App 'does-not-exist' not found in arigsela/kubernetes/base-apps/. Verify the app name is correct.",
    );
    expect(mock.git.createRef).not.toHaveBeenCalled();
    expect(mock.repos.deleteFile).not.toHaveBeenCalled();
  });

  it('directory_not_found_404_continues: deletes only top-level YAML', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent
      .mockResolvedValueOnce({ data: { sha: 'sha-toplevel' } })  // top-level exists
      .mockRejectedValueOnce({ status: 404 })  // directory missing
      .mockResolvedValueOnce({ data: { sha: 'sha-toplevel' } });  // SHA fetch for delete

    mock.repos.getBranch.mockRejectedValueOnce({ status: 404 });
    mock.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'main-sha' } } });
    mock.git.createRef.mockResolvedValueOnce({});
    mock.repos.deleteFile.mockResolvedValue({});
    mock.pulls.list.mockResolvedValueOnce({ data: [] });
    mock.pulls.create.mockResolvedValueOnce({ data: { html_url: 'https://github.com/arigsela/kubernetes/pull/301', number: 301 } });

    const ctx = createMockActionContext({ input: { name: 'minimal-app' } });
    const action = createDecommissionPullRequestAction();
    await action.handler(ctx);

    expect(mock.repos.deleteFile).toHaveBeenCalledTimes(1);
    expect(mock.repos.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'base-apps/minimal-app.yaml' }));
  });

  it('branch_already_exists_reuses: skips git.createRef', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent
      .mockResolvedValueOnce({ data: { sha: 'sha' } })  // top-level
      .mockResolvedValueOnce({ data: [] })  // empty directory
      .mockResolvedValueOnce({ data: { sha: 'sha' } });  // SHA for delete

    mock.repos.getBranch.mockResolvedValueOnce({ data: { name: 'chore/teardown-foo' } });  // branch exists!
    mock.repos.deleteFile.mockResolvedValue({});
    mock.pulls.list.mockResolvedValueOnce({ data: [] });
    mock.pulls.create.mockResolvedValueOnce({ data: { html_url: 'https://github.com/arigsela/kubernetes/pull/302', number: 302 } });

    const ctx = createMockActionContext({ input: { name: 'foo' } });
    const action = createDecommissionPullRequestAction();
    await action.handler(ctx);

    expect(mock.git.createRef).not.toHaveBeenCalled();
    expect(mock.repos.deleteFile).toHaveBeenCalled();
  });

  it('pr_already_open_returns_existing: skips pulls.create', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent
      .mockResolvedValueOnce({ data: { sha: 'sha' } })  // top-level check
      .mockResolvedValueOnce({ data: [] })               // empty directory
      .mockResolvedValueOnce({ data: { sha: 'sha' } }); // SHA fetch for top-level delete

    mock.repos.getBranch.mockResolvedValueOnce({ data: { name: 'chore/teardown-bar' } });
    mock.repos.deleteFile.mockResolvedValue({});
    // PR already open
    mock.pulls.list.mockResolvedValueOnce({ data: [{ html_url: 'https://github.com/arigsela/kubernetes/pull/303', number: 303 }] });

    const ctx = createMockActionContext({ input: { name: 'bar' } });
    const action = createDecommissionPullRequestAction();
    await action.handler(ctx);

    expect(mock.pulls.create).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith('remoteUrl', 'https://github.com/arigsela/kubernetes/pull/303');
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 303);
  });

  it('pr_create_race_condition_422: catches and returns race-winner PR', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent
      .mockResolvedValueOnce({ data: { sha: 'sha' } })  // top-level check
      .mockResolvedValueOnce({ data: [] })               // empty directory
      .mockResolvedValueOnce({ data: { sha: 'sha' } }); // SHA fetch for top-level delete

    mock.repos.getBranch.mockRejectedValueOnce({ status: 404 });
    mock.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'main-sha' } } });
    mock.git.createRef.mockResolvedValueOnce({});
    mock.repos.deleteFile.mockResolvedValue({});

    // First pulls.list shows empty
    mock.pulls.list.mockResolvedValueOnce({ data: [] });
    // pulls.create returns 422 race
    mock.pulls.create.mockRejectedValueOnce({ status: 422, message: 'A pull request already exists' });
    // Second pulls.list (after race catch) returns the racy PR
    mock.pulls.list.mockResolvedValueOnce({ data: [{ html_url: 'https://github.com/arigsela/kubernetes/pull/304', number: 304 }] });

    const ctx = createMockActionContext({ input: { name: 'baz' } });
    const action = createDecommissionPullRequestAction();
    await action.handler(ctx);

    expect(ctx.output).toHaveBeenCalledWith('remoteUrl', 'https://github.com/arigsela/kubernetes/pull/304');
  });

  it('missing_github_token_throws: clear operator-facing error', async () => {
    delete process.env.GITHUB_TOKEN;

    const ctx = createMockActionContext({ input: { name: 'foo' } });
    const action = createDecommissionPullRequestAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      'GITHUB_TOKEN env var is not set. Required for crossplane:teardown:open-decommission-pr.',
    );
  });
});
