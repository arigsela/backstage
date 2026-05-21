/**
 * Unit tests for the kagent-suggest HTTP route.
 *
 * Spins up a minimal Express app with the router mounted, fires requests
 * through supertest, asserts on the JSON response.
 */
import express from 'express';
import request from 'supertest';

import { createRouter } from './router';

function mockDiscovery(catalogBase = 'http://localhost:7007/api/catalog') {
  return {
    getBaseUrl: jest.fn().mockResolvedValue(catalogBase),
    getExternalBaseUrl: jest.fn().mockResolvedValue(catalogBase),
  } as any;
}

function buildEntity() {
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
      },
    },
    spec: { type: 'kagent-agent' },
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

function mockA2ASuccess(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'test',
      result: {
        kind: 'task',
        artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text }] }],
        status: { state: 'completed' },
      },
    }),
  } as any;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const router = await createRouter({
    discovery: mockDiscovery(),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: function () {
        return this;
      },
    } as any,
  });
  app.use('/api/kagent-suggest', router);
  return app;
}

describe('kagent-suggest router', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('happy path — returns ok:true with response, agentName, runtime, durationMs', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('Hello.'));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.response).toBe('Hello.');
    expect(res.body.agentName).toBe('foo-agent');
    expect(res.body.runtime).toBe('kagent');
    expect(typeof res.body.durationMs).toBe('number');
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('expectJson: true — parses JSON response', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('[{"id":"a","name":"A","description":"x"}]'));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi', expectJson: true });

    expect(res.body.ok).toBe(true);
    expect(res.body.response).toEqual([
      { id: 'a', name: 'A', description: 'x' },
    ]);
  });

  it('schema rejection — missing agentName returns BAD_INPUT', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('BAD_INPUT');
  });

  it('schema rejection — prompt over 8000 chars returns BAD_INPUT', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'x'.repeat(8001) });

    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('BAD_INPUT');
  });

  it('schema rejection — timeoutMs over 120000 returns BAD_INPUT', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi', timeoutMs: 250000 });

    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('BAD_INPUT');
  });

  it('AGENT_NOT_FOUND surfaces from resolver', async () => {
    fetchSpy.mockResolvedValueOnce(mockCatalogResponse({}, 404));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'missing-agent', prompt: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
    expect(res.body.message).toContain("'component:default/missing-agent'");
  });

  it('INVALID_RESPONSE_JSON when expectJson is true and agent returns non-JSON', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockCatalogResponse(buildEntity()))
      .mockResolvedValueOnce(mockA2ASuccess('not json'));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi', expectJson: true });

    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INVALID_RESPONSE_JSON');
  });

  it('OPTIONS preflight — returns 204 or 404 depending on cors config', async () => {
    const app = await buildApp();
    const res = await request(app).options('/api/kagent-suggest/invoke');
    expect([200, 204, 404]).toContain(res.status);
  });
});
