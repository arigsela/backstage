/**
 * Unit tests for kagent:mcp-server:validate-name.
 *
 * Mocks @octokit/rest's repos.getContent to simulate folder/file existence
 * and verifies the action throws clear errors on collision.
 */

import { createKagentMcpServerValidateNameAction } from './kagentMcpServerValidateNameAction';

const mockGetContent = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      getContent: mockGetContent,
    },
  })),
}));

const baseCtx = () => ({
  input: { name: 'test-mcp' },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  output: jest.fn(),
}) as any;

describe('kagent:mcp-server:validate-name', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghs_test-token';
    mockGetContent.mockReset();
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
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toThrow(
      /GITHUB_TOKEN env var is not set/,
    );
  });

  it('passes when neither folder nor legacy file exists', async () => {
    mockGetContent.mockRejectedValue({ status: 404 });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).resolves.toBeUndefined();
    expect(mockGetContent).toHaveBeenCalledTimes(2);
    expect(mockGetContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'base-apps/kagent/mcp-servers/test-mcp',
      }),
    );
    expect(mockGetContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'base-apps/kagent/mcp-servers/test-mcp.yaml',
      }),
    );
  });

  it('throws when the IDP folder already exists', async () => {
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'base-apps/kagent/mcp-servers/test-mcp') {
        return { data: [] };
      }
      throw { status: 404 };
    });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toThrow(
      /already exists at base-apps\/kagent\/mcp-servers\/test-mcp\//,
    );
  });

  it('throws when the legacy file already exists', async () => {
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'base-apps/kagent/mcp-servers/test-mcp.yaml') {
        return { data: { type: 'file' } };
      }
      throw { status: 404 };
    });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toThrow(
      /already exists at base-apps\/kagent\/mcp-servers\/test-mcp\.yaml/,
    );
  });

  it('propagates non-404 errors from Octokit', async () => {
    mockGetContent.mockRejectedValue({ status: 500, message: 'GitHub down' });
    const action = createKagentMcpServerValidateNameAction();

    await expect(action.handler(baseCtx())).rejects.toMatchObject({
      status: 500,
    });
  });
});
