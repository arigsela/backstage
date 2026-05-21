/**
 * Unit tests for AgentResolver — migrated from kagentInvokeAction.test.ts.
 * Tests resolver in isolation; no scaffolder context needed.
 */
import { AgentInvocationError } from './errors';
import { resolveAgent } from './resolver';

function mockDiscovery(catalogBase = 'http://localhost:7007/api/catalog') {
  return {
    getBaseUrl: jest.fn().mockResolvedValue(catalogBase),
    getExternalBaseUrl: jest.fn().mockResolvedValue(catalogBase),
  } as any;
}

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

function buildEntity(overrides: Record<string, any> = {}) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'foo-agent',
      namespace: 'default',
      annotations: {
        'agents.platform.ai/version': 'v1',
        'agents.platform.ai/runtime': 'kagent',
        'agents.platform.ai/a2a-endpoint':
          'http://foo-agent.kagent.svc.cluster.local:8080',
        ...(overrides.annotations ?? {}),
      },
    },
    spec: {
      type: 'kagent-agent',
      ...(overrides.spec ?? {}),
    },
  };
}

function mockCatalogResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
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
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse({}, 404));

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
      fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(AgentInvocationError);
      expect(e.code).toBe('AGENT_NOT_FOUND');
      expect(e.message).toContain("'component:default/foo-agent'");
    }
  });

  it('INVALID_CONTRACT when version != v1', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        annotations: { 'agents.platform.ai/version': 'v99' },
      })),
    );

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toContain('Unsupported contract version: v99');
    }
  });

  it('INVALID_CONTRACT when a2a-endpoint annotation is missing', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        annotations: { 'agents.platform.ai/a2a-endpoint': undefined },
      })),
    );

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toMatch(/a2a-endpoint/);
    }
  });

  it('INVALID_CONTRACT when runtime is not kagent', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        annotations: { 'agents.platform.ai/runtime': 'crewai' },
      })),
    );

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toContain('Unsupported runtime: crewai');
    }
  });

  it('INVALID_CONTRACT when spec.type is not kagent-agent', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockCatalogResponse(buildEntity({
        spec: { type: 'service' },
      })),
    );

    try {
      await resolveAgent(mockDiscovery(), 'foo-agent', mockLogger());
      fail('expected throw');
    } catch (e: any) {
      expect(e.code).toBe('INVALID_CONTRACT');
      expect(e.message).toContain('not a kagent-agent');
    }
  });

  it('returns endpoint info on a valid v1 entity', async () => {
    const discovery = mockDiscovery('http://localhost:7007/api/catalog');
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse(buildEntity()));

    const info = await resolveAgent(discovery, 'foo-agent', mockLogger());

    expect(info).toEqual({
      endpoint: 'http://foo-agent.kagent.svc.cluster.local:8080',
      runtime: 'kagent',
      contractVersion: 'v1',
    });
    expect(discovery.getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://localhost:7007/api/catalog/entities/by-name/component/default/foo-agent',
    );
  });
});
