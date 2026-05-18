/**
 * Unit tests for kagent:agent:open-decommission-pr action.
 *
 * 6 test cases:
 *   1. happy_path_idp_managed_agent
 *   2. agent_not_found_404
 *   3. agent_not_idp_managed_throws
 *   4. branch_already_exists_reuses
 *   5. pr_already_open_returns_existing
 *   6. missing_github_token_throws
 */

import { createKagentDecommissionAction } from './kagentDecommissionAction';

jest.mock('@octokit/rest');
import { Octokit } from '@octokit/rest';

const MockedOctokit = Octokit as jest.MockedClass<typeof Octokit>;

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

/**
 * Helper: build a base64-encoded YAML body that matches GitHub's getContent
 * response shape for a single-file fetch.
 */
function encodeYamlForGetContent(yaml: string, sha = 'agent-sha') {
  return {
    data: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(yaml, 'utf-8').toString('base64'),
      sha,
    },
  };
}

const IDP_MANAGED_YAML = `apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: release-coordinator
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
    app.kubernetes.io/managed-by: backstage-scaffolder
spec:
  description: test agent
`;

const HAND_CRAFTED_YAML = `apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: build-orchestrator
  namespace: kagent
  labels:
    app.kubernetes.io/part-of: kagent
spec:
  description: hand-crafted agent
`;

describe('kagent:agent:open-decommission-pr', () => {
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

  it('happy_path_idp_managed_agent: opens PR after deleting file', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    // First getContent: existence + label check
    mock.repos.getContent.mockResolvedValueOnce(
      encodeYamlForGetContent(IDP_MANAGED_YAML, 'sha-1'),
    );
    // Branch doesn't exist
    mock.repos.getBranch.mockRejectedValueOnce({ status: 404 });
    mock.git.getRef.mockResolvedValueOnce({
      data: { object: { sha: 'main-sha' } },
    });
    mock.git.createRef.mockResolvedValueOnce({});
    // SHA fetch on the branch for the delete
    mock.repos.getContent.mockResolvedValueOnce(
      encodeYamlForGetContent(IDP_MANAGED_YAML, 'sha-2-on-branch'),
    );
    mock.repos.deleteFile.mockResolvedValueOnce({});
    mock.pulls.list.mockResolvedValueOnce({ data: [] });
    mock.pulls.create.mockResolvedValueOnce({
      data: {
        html_url: 'https://github.com/arigsela/kubernetes/pull/400',
        number: 400,
      },
    });

    const ctx = createMockActionContext({
      input: { name: 'release-coordinator' },
    });
    const action = createKagentDecommissionAction();
    await action.handler(ctx);

    expect(mock.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'base-apps/kagent/agents/release-coordinator.yaml',
      }),
    );
    expect(mock.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'refs/heads/scaffolder/decommission-kagent-release-coordinator',
      }),
    );
    expect(mock.repos.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'base-apps/kagent/agents/release-coordinator.yaml',
        sha: 'sha-2-on-branch',
        branch: 'scaffolder/decommission-kagent-release-coordinator',
      }),
    );
    expect(mock.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'chore(kagent): decommission agent release-coordinator',
        base: 'main',
      }),
    );
    expect(ctx.output).toHaveBeenCalledWith(
      'remoteUrl',
      'https://github.com/arigsela/kubernetes/pull/400',
    );
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 400);
    expect(ctx.output).toHaveBeenCalledWith(
      'branchName',
      'scaffolder/decommission-kagent-release-coordinator',
    );
  });

  it('agent_not_found_404: throws with clear error', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent.mockRejectedValueOnce({ status: 404 });

    const ctx = createMockActionContext({ input: { name: 'does-not-exist' } });
    const action = createKagentDecommissionAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      "Agent 'does-not-exist' not found at base-apps/kagent/agents/does-not-exist.yaml. Either it was already decommissioned or it is hand-crafted (only IDP-managed agents under base-apps/kagent/agents/ can be torn down via the IDP).",
    );
    expect(mock.git.createRef).not.toHaveBeenCalled();
  });

  it('agent_not_idp_managed_throws: refuses to delete hand-crafted agent', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    // File exists but YAML lacks managed-by: backstage-scaffolder
    mock.repos.getContent.mockResolvedValueOnce(
      encodeYamlForGetContent(HAND_CRAFTED_YAML),
    );

    const ctx = createMockActionContext({ input: { name: 'build-orchestrator' } });
    const action = createKagentDecommissionAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      "Agent 'build-orchestrator' is not IDP-managed (missing label app.kubernetes.io/managed-by=backstage-scaffolder). Tear down by hand to avoid removing unrelated files.",
    );
    expect(mock.git.createRef).not.toHaveBeenCalled();
    expect(mock.repos.deleteFile).not.toHaveBeenCalled();
  });

  it('branch_already_exists_reuses: skips git.createRef', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent.mockResolvedValueOnce(
      encodeYamlForGetContent(IDP_MANAGED_YAML),
    );
    // Branch exists
    mock.repos.getBranch.mockResolvedValueOnce({
      data: { name: 'scaffolder/decommission-kagent-foo' },
    });
    mock.repos.getContent.mockResolvedValueOnce(
      encodeYamlForGetContent(IDP_MANAGED_YAML, 'sha-on-branch'),
    );
    mock.repos.deleteFile.mockResolvedValueOnce({});
    mock.pulls.list.mockResolvedValueOnce({ data: [] });
    mock.pulls.create.mockResolvedValueOnce({
      data: {
        html_url: 'https://github.com/arigsela/kubernetes/pull/401',
        number: 401,
      },
    });

    const ctx = createMockActionContext({ input: { name: 'foo' } });
    const action = createKagentDecommissionAction();
    await action.handler(ctx);

    expect(mock.git.createRef).not.toHaveBeenCalled();
    expect(mock.repos.deleteFile).toHaveBeenCalled();
  });

  it('pr_already_open_returns_existing: skips pulls.create', async () => {
    const mock = buildMockOctokit();
    MockedOctokit.mockImplementation(() => mock);

    mock.repos.getContent.mockResolvedValueOnce(
      encodeYamlForGetContent(IDP_MANAGED_YAML),
    );
    mock.repos.getBranch.mockResolvedValueOnce({
      data: { name: 'scaffolder/decommission-kagent-bar' },
    });
    mock.repos.getContent.mockResolvedValueOnce(
      encodeYamlForGetContent(IDP_MANAGED_YAML, 'sha-on-branch'),
    );
    mock.repos.deleteFile.mockResolvedValueOnce({});
    mock.pulls.list.mockResolvedValueOnce({
      data: [
        {
          html_url: 'https://github.com/arigsela/kubernetes/pull/402',
          number: 402,
        },
      ],
    });

    const ctx = createMockActionContext({ input: { name: 'bar' } });
    const action = createKagentDecommissionAction();
    await action.handler(ctx);

    expect(mock.pulls.create).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith(
      'remoteUrl',
      'https://github.com/arigsela/kubernetes/pull/402',
    );
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 402);
  });

  it('missing_github_token_throws: clear operator-facing error', async () => {
    delete process.env.GITHUB_TOKEN;

    const ctx = createMockActionContext({ input: { name: 'foo' } });
    const action = createKagentDecommissionAction();

    await expect(action.handler(ctx)).rejects.toThrow(
      'GITHUB_TOKEN env var is not set. Required for kagent:agent:open-decommission-pr.',
    );
  });
});
