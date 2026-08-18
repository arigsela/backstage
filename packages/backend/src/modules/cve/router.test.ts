import express from 'express';
import request from 'supertest';
import { createRouter } from './router';
import { reduceReport, historyPointFromRaw } from './aggregate';
import type { RawReport } from './types';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

function report(image: string, ids: string[]): RawReport {
  return {
    scanned: [image],
    failed: [],
    findings: ids.map(id => ({
      image,
      id,
      pkg: 'openssl',
      installed: '3.0.11',
      fixed: '3.0.14',
      severity: 'CRITICAL',
      title: 't',
    })),
  };
}

/** Like `report`, but scans multiple images and lets findings target any of them. */
function multiReport(
  scanned: string[],
  findings: { image: string; id: string }[],
): RawReport {
  return {
    scanned,
    failed: [],
    findings: findings.map(f => ({
      image: f.image,
      id: f.id,
      pkg: 'openssl',
      installed: '3.0.11',
      fixed: '3.0.14',
      severity: 'CRITICAL',
      title: 't',
    })),
  };
}

function stubStore(over: any = {}) {
  return {
    getLatest: jest.fn().mockResolvedValue({
      date: '2026-08-17',
      reduced: reduceReport(report('team/app:v2', ['CVE-1', 'CVE-2'])),
    }),
    getHistory: jest
      .fn()
      .mockResolvedValue([
        historyPointFromRaw(
          '2026-08-10',
          report('team/app:v1', ['CVE-1', 'CVE-2', 'CVE-3']),
        ),
        historyPointFromRaw(
          '2026-08-17',
          report('team/app:v2', ['CVE-1', 'CVE-2']),
        ),
      ]),
    health: jest
      .fn()
      .mockResolvedValue({ keysFound: 3, dates: ['2026-08-17'] }),
    ...over,
  } as any;
}

async function appWith(store: any) {
  const app = express();
  app.use(await createRouter({ store, logger }));
  return app;
}

describe('POST /report', () => {
  it('parses a JSON body — the router mounts its own parser', async () => {
    // Guards commit 0c97027: without router.use(express.json()) req.body is
    // undefined here and this returns BAD_INPUT.
    const res = await request(await appWith(stubStore()))
      .post('/report')
      .send({ images: ['team/app:v2'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns totals and findings for a matched image', async () => {
    const res = await request(await appWith(stubStore()))
      .post('/report')
      .send({ images: ['team/app:v9'] });
    expect(res.body.scannedAt).toBe('2026-08-17');
    expect(res.body.totals).toEqual({ critical: 2, high: 0, actionable: 2 });
    expect(res.body.matchedRefs).toEqual(['team/app:v9']);
    expect(res.body.findings).toHaveLength(2);
  });

  it('reports an unscanned image as unmatched, not as clean', async () => {
    const res = await request(await appWith(stubStore()))
      .post('/report')
      .send({ images: ['team/never:v1'] });
    expect(res.body.matchedRefs).toEqual([]);
    expect(res.body.unmatchedRefs).toEqual(['team/never:v1']);
  });

  it('builds a trend point per week, oldest first', async () => {
    const res = await request(await appWith(stubStore()))
      .post('/report')
      .send({ images: ['team/app:v2'] });
    expect(res.body.trend).toEqual([
      { date: '2026-08-10', actionable: 3, covered: true },
      { date: '2026-08-17', actionable: 2, covered: true },
    ]);
  });

  it('marks a week that did not scan the repo as not covered', async () => {
    const store = stubStore({
      getHistory: jest
        .fn()
        .mockResolvedValue([
          historyPointFromRaw(
            '2026-08-10',
            report('other/thing:v1', ['CVE-9']),
          ),
          historyPointFromRaw(
            '2026-08-17',
            report('team/app:v2', ['CVE-1', 'CVE-2']),
          ),
        ]),
    });
    const res = await request(await appWith(store))
      .post('/report')
      .send({ images: ['team/app:v2'] });
    expect(res.body.trend[0]).toEqual({
      date: '2026-08-10',
      actionable: 0,
      covered: false,
    });
  });

  it('marks a scanned-but-clean week as covered, not as a gap', async () => {
    // `covered` must be derived from scan coverage (scannedRepos), never
    // from the finding count. A wrong implementation like
    // `covered: actionable > 0` would pass every other test in this file
    // (every covered:true fixture above happens to have nonzero actionable,
    // and the only covered:false fixture happens to have zero actionable) —
    // this case decouples the two so that confounded mistake gets caught.
    const store = stubStore({
      getHistory: jest
        .fn()
        .mockResolvedValue([
          historyPointFromRaw('2026-08-10', report('team/app:v3', [])),
          historyPointFromRaw(
            '2026-08-17',
            report('team/app:v2', ['CVE-1', 'CVE-2']),
          ),
        ]),
    });
    const res = await request(await appWith(store))
      .post('/report')
      .send({ images: ['team/app:v2'] });
    expect(res.body.trend[0]).toEqual({
      date: '2026-08-10',
      actionable: 0,
      covered: true,
    });
  });

  it('does not double-count a repo running two tags in the trend', async () => {
    // Fix B regression: two tags of one repo (mid-rollout) both normalize to
    // the same repo path. Before deduping `repos`, the newest trend point
    // summed that repo's count twice while the headline (deduped in
    // aggregate.ts) counted it once — a phantom "+N" regression between the
    // headline and the sparkline's own last point.
    const store = stubStore({
      getLatest: jest.fn().mockResolvedValue({
        date: '2026-08-17',
        reduced: reduceReport(report('team/app:v2', ['CVE-1', 'CVE-2'])),
      }),
      getHistory: jest
        .fn()
        .mockResolvedValue([
          historyPointFromRaw(
            '2026-08-17',
            report('team/app:v2', ['CVE-1', 'CVE-2']),
          ),
        ]),
    });
    const res = await request(await appWith(store))
      .post('/report')
      .send({ images: ['team/app:v2', 'team/app:v3'] });
    // Two pod-running tags of the same repo both match the one scanned repo.
    expect(res.body.matchedRefs).toEqual(['team/app:v2', 'team/app:v3']);
    expect(res.body.totals.actionable).toBe(2);
    const newest = res.body.trend[res.body.trend.length - 1];
    expect(newest.actionable).toBe(res.body.totals.actionable);
  });

  it('marks a week as a gap, not a real point, when it only scanned some of a multi-image component', async () => {
    // Fix C regression: with `some`, a week that scanned only one of two
    // repos was marked covered while `actionable` summed only the scanned
    // subset — a fake improvement with a real-looking "vs last scan" delta
    // attached to a report that was actually incomplete that week.
    const store = stubStore({
      // Latest scan covers both repos, so both are matched — this is the
      // component's current two-image shape.
      getLatest: jest.fn().mockResolvedValue({
        date: '2026-08-17',
        reduced: reduceReport(
          multiReport(
            ['team/app:v2', 'team/api:v1'],
            [{ image: 'team/app:v2', id: 'CVE-1' }],
          ),
        ),
      }),
      getHistory: jest.fn().mockResolvedValue([
        // Only team/app was scanned this week; team/api was not.
        historyPointFromRaw(
          '2026-08-10',
          multiReport(['team/app:v1'], [{ image: 'team/app:v1', id: 'CVE-1' }]),
        ),
        historyPointFromRaw(
          '2026-08-17',
          multiReport(
            ['team/app:v2', 'team/api:v1'],
            [
              { image: 'team/app:v2', id: 'CVE-1' },
              { image: 'team/api:v1', id: 'CVE-2' },
            ],
          ),
        ),
      ]),
    });
    const res = await request(await appWith(store))
      .post('/report')
      .send({ images: ['team/app:v2', 'team/api:v1'] });
    expect(res.body.matchedRefs).toEqual(['team/app:v2', 'team/api:v1']);
    expect(res.body.trend[0]).toEqual({
      date: '2026-08-10',
      actionable: 1,
      covered: false,
    });
    expect(res.body.trend[1]).toEqual({
      date: '2026-08-17',
      actionable: 2,
      covered: true,
    });
  });

  it('rejects a missing or malformed images array', async () => {
    const app = await appWith(stubStore());
    for (const body of [{}, { images: 'nope' }, { images: [1, 2] }]) {
      const res = await request(app).post('/report').send(body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, code: 'BAD_INPUT' });
    }
  });

  it('reports a store failure as an error, never as zero findings', async () => {
    const store = stubStore({
      getLatest: jest.fn().mockRejectedValue(new Error('AccessDenied')),
    });
    const res = await request(await appWith(store))
      .post('/report')
      .send({ images: ['team/app:v2'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('REPORT_UNAVAILABLE');
    expect(res.body.totals).toBeUndefined();
  });
});

describe('GET /health', () => {
  it('reports which report keys exist', async () => {
    const res = await request(await appWith(stubStore())).get('/health');
    expect(res.body).toMatchObject({ ok: true, keysFound: 3 });
  });

  it('reports a bucket failure as an error, never a thrown 5xx', async () => {
    const store = stubStore({
      health: jest.fn().mockRejectedValue(new Error('NoSuchBucket')),
    });
    const res = await request(await appWith(store)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('BUCKET_UNREACHABLE');
    expect(res.body.message).toBe('NoSuchBucket');
  });
});
