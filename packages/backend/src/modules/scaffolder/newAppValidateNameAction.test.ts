import { createNewAppValidateNameAction } from './newAppValidateNameAction';

jest.mock('@octokit/rest');
import { Octokit } from '@octokit/rest';

const MockedOctokit = Octokit as jest.MockedClass<typeof Octokit>;

function buildMockOctokit() {
  return { repos: { getContent: jest.fn() } } as any;
}
function createMockActionContext(opts: { input: Record<string, unknown> }) {
  return {
    input: opts.input,
    output: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn().mockReturnThis() },
    workspacePath: '/tmp/t', checkpoint: jest.fn(),
    createTemporaryDirectory: jest.fn().mockResolvedValue('/tmp/t2'),
    getInitiatorCredentials: jest.fn(), task: { id: 't' },
  } as any;
}
function http(status: number) { const e: any = new Error(`HTTP ${status}`); e.status = status; return e; }

describe('newapp:validate-name', () => {
  let orig: string | undefined;
  beforeEach(() => { orig = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'x'; MockedOctokit.mockClear(); });
  afterEach(() => { if (orig === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = orig; });

  it('passes when neither path exists', async () => {
    const oc = buildMockOctokit();
    oc.repos.getContent.mockRejectedValue(http(404));
    MockedOctokit.mockImplementation(() => oc);
    await expect(
      createNewAppValidateNameAction().handler(createMockActionContext({ input: { name: 'brand-new' } })),
    ).resolves.toBeUndefined();
  });

  it('throws when the app directory exists', async () => {
    const oc = buildMockOctokit();
    oc.repos.getContent.mockImplementation(async ({ path }: any) =>
      path === 'base-apps/whoami-test' ? { data: [] } : Promise.reject(http(404)),
    );
    MockedOctokit.mockImplementation(() => oc);
    await expect(
      createNewAppValidateNameAction().handler(createMockActionContext({ input: { name: 'whoami-test' } })),
    ).rejects.toThrow(/already exists at base-apps\/whoami-test/);
  });

  it('throws when only the Argo app file exists', async () => {
    const oc = buildMockOctokit();
    oc.repos.getContent.mockImplementation(async ({ path }: any) =>
      path === 'base-apps/foo.yaml' ? { data: {} } : Promise.reject(http(404)),
    );
    MockedOctokit.mockImplementation(() => oc);
    await expect(
      createNewAppValidateNameAction().handler(createMockActionContext({ input: { name: 'foo' } })),
    ).rejects.toThrow(/already exists at base-apps\/foo\.yaml/);
  });

  it('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(
      createNewAppValidateNameAction().handler(createMockActionContext({ input: { name: 'x' } })),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });
});
