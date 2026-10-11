/**
 * Unit tests for the kagent-suggest HTTP route.
 *
 * Spins up a minimal Express app with the router mounted, fires requests
 * through supertest, asserts on the JSON response.
 */
import express from 'express';
import request from 'supertest';

import { createRouter } from './router';
import {
  a2aResponse,
  agentEntity,
  completedTask,
} from '../kagent-shared/__fixtures__/a2a';

function mockDiscovery(catalogBase = 'http://localhost:7007/api/catalog') {
  return {
    getBaseUrl: jest.fn().mockResolvedValue(catalogBase),
    getExternalBaseUrl: jest.fn().mockResolvedValue(catalogBase),
  } as any;
}

async function buildApp(a2a?: { a2aBaseUrl?: string; userId?: string }) {
  const app = express();
  app.use(express.json());
  const router = await createRouter({
    discovery: mockDiscovery(),
    a2a,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child() {
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
      .mockResolvedValueOnce(a2aResponse(agentEntity()))
      .mockResolvedValueOnce(a2aResponse(completedTask('Hello.')));

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

  it('calls the configured kagent controller gateway as the configured user', async () => {
    fetchSpy
      .mockResolvedValueOnce(a2aResponse(agentEntity()))
      .mockResolvedValueOnce(a2aResponse(completedTask('ok')));

    const app = await buildApp({ a2aBaseUrl: 'http://kagent.test:8083', userId: 'tester' });
    const res = await request(app)
      .post('/api/kagent-suggest/invoke')
      .send({ agentName: 'foo-agent', prompt: 'hi' });

    expect(res.body.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[1];
    expect(url).toBe('http://kagent.test:8083/agents/kagent/foo-agent');
    expect(init.headers['X-User-Id']).toBe('tester');
    expect(JSON.parse(init.body).method).toBe('SendMessage');
  });

  it('expectJson: true — parses JSON response', async () => {
    fetchSpy
      .mockResolvedValueOnce(a2aResponse(agentEntity()))
      .mockResolvedValueOnce(a2aResponse(completedTask('[{"id":"a","name":"A","description":"x"}]')));

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
    fetchSpy.mockResolvedValueOnce(a2aResponse({}, 404));

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
      .mockResolvedValueOnce(a2aResponse(agentEntity()))
      .mockResolvedValueOnce(a2aResponse(completedTask('not json')));

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
