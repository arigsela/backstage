/**
 * Unit tests for resolveAgent: catalog entity (ingested from a kagent 1.0
 * Agent) → the controller's A2A gateway URL.
 */
import { resolveAgent } from './resolver';
import {
  a2aResponse as catalogResponse,
  agentEntity,
} from './__fixtures__/a2a';

function mockDiscovery(catalogBase = 'http://localhost:7007/api/catalog') {
  return {
    getBaseUrl: jest.fn().mockResolvedValue(catalogBase),
    getExternalBaseUrl: jest.fn().mockResolvedValue(catalogBase),
  } as any;
}

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

describe('resolveAgent', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('AGENT_NOT_FOUND when catalog returns 404', async () => {
    fetchSpy.mockResolvedValueOnce(catalogResponse({}, 404));

    await expect(
      resolveAgent(mockDiscovery(), 'foo-agent', mockLogger()),
    ).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      message: expect.stringContaining("'component:default/foo-agent'"),
    });
  });

  it('INVALID_CONTRACT when spec.type is not kagent-agent', async () => {
    fetchSpy.mockResolvedValueOnce(
      catalogResponse(agentEntity({ spec: { type: 'service' } })),
    );

    await expect(
      resolveAgent(mockDiscovery(), 'foo-agent', mockLogger()),
    ).rejects.toMatchObject({
      code: 'INVALID_CONTRACT',
      message: expect.stringContaining('not a kagent-agent'),
    });
  });

  it('INVALID_CONTRACT for an entity ingested from a kagent 0.10 Deployment', async () => {
    fetchSpy.mockResolvedValueOnce(
      catalogResponse(
        agentEntity({
          annotations: {
            'terasky.backstage.io/kubernetes-resource-kind': 'Deployment',
            'terasky.backstage.io/kubernetes-resource-api-version': 'apps/v1',
          },
        }),
      ),
    );

    await expect(
      resolveAgent(mockDiscovery(), 'foo-agent', mockLogger()),
    ).rejects.toMatchObject({
      code: 'INVALID_CONTRACT',
      message: expect.stringContaining('Deployment apps/v1'),
    });
  });

  it('INVALID_CONTRACT for a kagent.dev/v1alpha2 Agent', async () => {
    fetchSpy.mockResolvedValueOnce(
      catalogResponse(
        agentEntity({
          annotations: {
            'terasky.backstage.io/kubernetes-resource-api-version':
              'kagent.dev/v1alpha2',
          },
        }),
      ),
    );

    await expect(
      resolveAgent(mockDiscovery(), 'foo-agent', mockLogger()),
    ).rejects.toMatchObject({
      code: 'INVALID_CONTRACT',
    });
  });

  it('INVALID_CONTRACT when the namespace is not a DNS label', async () => {
    fetchSpy.mockResolvedValueOnce(
      catalogResponse(
        agentEntity({
          annotations: {
            'terasky.backstage.io/kubernetes-resource-namespace':
              '../kube-system',
            'backstage.io/kubernetes-namespace': undefined,
          },
        }),
      ),
    );

    await expect(
      resolveAgent(mockDiscovery(), 'foo-agent', mockLogger()),
    ).rejects.toMatchObject({
      code: 'INVALID_CONTRACT',
      message: expect.stringContaining('does not name a valid Agent'),
    });
  });

  it('returns the controller A2A URL for a 1.0 Agent entity', async () => {
    const discovery = mockDiscovery('http://localhost:7007/api/catalog');
    fetchSpy.mockResolvedValueOnce(catalogResponse(agentEntity()));

    const info = await resolveAgent(discovery, 'foo-agent', mockLogger());

    expect(info).toEqual({
      endpoint:
        'http://kagent-controller.kagent.svc.cluster.local:8083/agents/kagent/foo-agent',
      runtime: 'kagent',
      namespace: 'kagent',
      agent: 'foo-agent',
    });
    expect(discovery.getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://localhost:7007/api/catalog/entities/by-name/component/default/foo-agent',
    );
  });

  it('uses the Agent name and namespace from the ingestor annotations', async () => {
    fetchSpy.mockResolvedValueOnce(
      catalogResponse(
        agentEntity({
          annotations: {
            'terasky.backstage.io/kubernetes-resource-name': 'real-name',
            'terasky.backstage.io/kubernetes-resource-namespace': 'agents',
          },
        }),
      ),
    );

    const info = await resolveAgent(
      mockDiscovery(),
      'foo-agent',
      mockLogger(),
      {
        a2aBaseUrl: 'http://127.0.0.1:8083/',
      },
    );

    expect(info.endpoint).toBe('http://127.0.0.1:8083/agents/agents/real-name');
  });
});
