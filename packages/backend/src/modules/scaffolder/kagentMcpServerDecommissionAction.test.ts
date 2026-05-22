/**
 * Unit tests for kagent:mcp-server:open-decommission-pr.
 *
 * Mocks Octokit's repos, git, and pulls endpoints to simulate the folder
 * walk + multi-file delete + PR creation flow.
 */

import { createKagentMcpServerDecommissionAction } from './kagentMcpServerDecommissionAction';

const mockGetContent = jest.fn();
const mockGetBranch = jest.fn();
const mockGetRef = jest.fn();
const mockCreateRef = jest.fn();
const mockDeleteFile = jest.fn();
const mockListPulls = jest.fn();
const mockCreatePr = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      getContent: mockGetContent,
      getBranch: mockGetBranch,
      deleteFile: mockDeleteFile,
    },
    git: {
      getRef: mockGetRef,
      createRef: mockCreateRef,
    },
    pulls: {
      list: mockListPulls,
      create: mockCreatePr,
    },
  })),
}));

const baseCtx = (name = 'test-mcp') =>
  ({
    input: { name },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    output: jest.fn(),
  }) as any;

// Helper to base64-encode a YAML body for getContent file responses.
const yamlBody = (idpManaged: boolean) =>
  Buffer.from(
    [
      'apiVersion: kagent.dev/v1alpha1',
      'kind: MCPServer',
      'metadata:',
      '  name: test-mcp',
      '  labels:',
      idpManaged ? '    arigsela.com/idp-managed: "true"' : '    app: other',
    ].join('\n'),
  ).toString('base64');

describe('kagent:mcp-server:open-decommission-pr', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghs_test-token';
    [
      mockGetContent,
      mockGetBranch,
      mockGetRef,
      mockCreateRef,
      mockDeleteFile,
      mockListPulls,
      mockCreatePr,
    ].forEach(m => m.mockReset());
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /GITHUB_TOKEN env var is not set/,
    );
  });

  it('throws when the folder is missing', async () => {
    mockGetContent.mockRejectedValueOnce({ status: 404 });
    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /not found at base-apps\/kagent\/mcp-servers\/test-mcp/,
    );
  });

  it('throws when the path is a file, not a folder', async () => {
    mockGetContent.mockResolvedValueOnce({ data: { type: 'file' } });
    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /Expected .* to be a folder/,
    );
  });

  it('refuses when any file is not IDP-managed', async () => {
    mockGetContent
      // listing the folder
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
          { type: 'file', name: 'externalsecret.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/externalsecret.yaml' },
        ],
      })
      // mcpserver.yaml — IDP-managed
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      // externalsecret.yaml — NOT IDP-managed
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(false) } });

    const action = createKagentMcpServerDecommissionAction();
    await expect(action.handler(baseCtx())).rejects.toThrow(
      /externalsecret\.yaml is not IDP-managed/,
    );
  });

  it('happy path deletes all files and opens a PR', async () => {
    mockGetContent
      // folder listing
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
          { type: 'file', name: 'externalsecret.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/externalsecret.yaml' },
        ],
      })
      // both files IDP-managed (label check)
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      // SHA fetches on the branch (one per file)
      .mockResolvedValueOnce({ data: { sha: 'aaaa' } })
      .mockResolvedValueOnce({ data: { sha: 'bbbb' } });

    mockGetBranch.mockRejectedValueOnce({ status: 404 });
    mockGetRef.mockResolvedValueOnce({ data: { object: { sha: 'mainsha' } } });
    mockCreateRef.mockResolvedValueOnce({});
    mockDeleteFile.mockResolvedValue({});
    mockListPulls.mockResolvedValueOnce({ data: [] });
    mockCreatePr.mockResolvedValueOnce({
      data: { number: 42, html_url: 'https://github.com/arigsela/kubernetes/pull/42' },
    });

    const ctx = baseCtx();
    const action = createKagentMcpServerDecommissionAction();
    await action.handler(ctx);

    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    expect(ctx.output).toHaveBeenCalledWith('remoteUrl', 'https://github.com/arigsela/kubernetes/pull/42');
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 42);
    expect(ctx.output).toHaveBeenCalledWith('branchName', 'scaffolder/decommission-mcp-server-test-mcp');
  });

  it('reuses an open PR if one exists', async () => {
    mockGetContent
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
        ],
      })
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      .mockResolvedValueOnce({ data: { sha: 'aaaa' } });
    mockGetBranch.mockResolvedValueOnce({}); // branch exists
    mockDeleteFile.mockResolvedValue({});
    mockListPulls.mockResolvedValueOnce({
      data: [{ number: 99, html_url: 'https://github.com/arigsela/kubernetes/pull/99' }],
    });

    const ctx = baseCtx();
    const action = createKagentMcpServerDecommissionAction();
    await action.handler(ctx);

    expect(mockCreatePr).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith('remoteUrl', 'https://github.com/arigsela/kubernetes/pull/99');
  });

  it('treats already-missing files as already-deleted and continues', async () => {
    mockGetContent
      .mockResolvedValueOnce({
        data: [
          { type: 'file', name: 'mcpserver.yaml', path: 'base-apps/kagent/mcp-servers/test-mcp/mcpserver.yaml' },
        ],
      })
      .mockResolvedValueOnce({ data: { type: 'file', content: yamlBody(true) } })
      // SHA fetch on branch → 404 (file already gone)
      .mockRejectedValueOnce({ status: 404 });
    mockGetBranch.mockResolvedValueOnce({});
    mockListPulls.mockResolvedValueOnce({ data: [] });
    mockCreatePr.mockResolvedValueOnce({
      data: { number: 7, html_url: 'https://example.com/pr/7' },
    });

    const ctx = baseCtx();
    const action = createKagentMcpServerDecommissionAction();
    await action.handler(ctx);

    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith('prNumber', 7);
  });
});
