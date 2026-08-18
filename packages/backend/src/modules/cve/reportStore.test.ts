import { ReportStore } from './reportStore';
import type { CveConfig } from './config';
import type { ReportSource } from './s3Client';
import type { RawReport } from './types';

const cfg: CveConfig = {
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'cve-reports/',
  cacheTtlMs: 60_000,
  historyWeeks: 3,
};

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

function fakeSource(objects: Record<string, RawReport>) {
  const getJson = jest.fn(async (key: string) => {
    if (!(key in objects)) throw new Error(`NoSuchKey: ${key}`);
    return objects[key];
  });
  const listKeys = jest.fn(async (prefix: string) =>
    Object.keys(objects).filter(k => k.startsWith(prefix)),
  );
  return { source: { getJson, listKeys } as ReportSource, getJson, listKeys };
}

describe('ReportStore.getLatest', () => {
  it('fetches and reduces latest.json', async () => {
    const { source } = fakeSource({
      'cve-reports/latest.json': report('team/app:v1', ['CVE-1', 'CVE-2']),
      'cve-reports/2026-08-17.json': report('team/app:v1', ['CVE-1', 'CVE-2']),
    });
    const store = new ReportStore(source, cfg);
    const latest = await store.getLatest();
    expect(latest.date).toBe('2026-08-17');
    expect(latest.reduced.byRepo.get('team/app')).toHaveLength(2);
  });

  it('serves from cache within the TTL', async () => {
    const { source, getJson } = fakeSource({
      'cve-reports/latest.json': report('team/app:v1', ['CVE-1']),
      'cve-reports/2026-08-17.json': report('team/app:v1', ['CVE-1']),
    });
    let now = 1_000_000;
    const store = new ReportStore(source, cfg, () => now);
    await store.getLatest();
    const callsAfterFirst = getJson.mock.calls.length;
    now += 30_000; // still inside the 60s TTL
    await store.getLatest();
    expect(getJson.mock.calls.length).toBe(callsAfterFirst);
  });

  it('refetches once the TTL expires', async () => {
    const { source, getJson } = fakeSource({
      'cve-reports/latest.json': report('team/app:v1', ['CVE-1']),
      'cve-reports/2026-08-17.json': report('team/app:v1', ['CVE-1']),
    });
    let now = 1_000_000;
    const store = new ReportStore(source, cfg, () => now);
    await store.getLatest();
    const callsAfterFirst = getJson.mock.calls.length;
    now += 120_000; // past the TTL
    await store.getLatest();
    expect(getJson.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('raises on a malformed report instead of reporting zero findings', async () => {
    const { source } = fakeSource({
      'cve-reports/latest.json': { scanned: [] } as any,
    });
    const store = new ReportStore(source, cfg);
    await expect(store.getLatest()).rejects.toThrow(/findings/);
  });
});

describe('ReportStore.getHistory', () => {
  const objects = {
    'cve-reports/latest.json': report('team/app:v4', ['CVE-1']),
    'cve-reports/2026-08-17.json': report('team/app:v4', ['CVE-1']),
    'cve-reports/2026-08-10.json': report('team/app:v3', ['CVE-1', 'CVE-2']),
    'cve-reports/2026-08-03.json': report('team/app:v2', [
      'CVE-1',
      'CVE-2',
      'CVE-3',
    ]),
    'cve-reports/2026-07-27.json': report('team/app:v1', ['CVE-1']),
  };

  it('returns oldest-first, truncated to historyWeeks', async () => {
    const { source } = fakeSource(objects);
    const points = await new ReportStore(source, cfg).getHistory();
    expect(points.map(p => p.date)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
    ]);
  });

  it('counts actionable findings per repo per week', async () => {
    const { source } = fakeSource(objects);
    const points = await new ReportStore(source, cfg).getHistory();
    expect(points.map(p => p.countsByRepo.get('team/app'))).toEqual([3, 2, 1]);
  });

  it('caches dated reports permanently — they are immutable', async () => {
    const { source, getJson } = fakeSource(objects);
    let now = 1_000_000;
    const store = new ReportStore(source, cfg, () => now);
    await store.getHistory();
    const calls = getJson.mock.calls.length;
    now += 10 * 60 * 60 * 1000; // ten hours later, far past any TTL
    await store.getHistory();
    // listKeys runs again; getJson for dated reports must not.
    expect(getJson.mock.calls.length).toBe(calls);
  });

  it('ignores keys that are not dated reports', async () => {
    const { source } = fakeSource({
      ...objects,
      'cve-reports/README.txt': report('x', []),
    });
    const points = await new ReportStore(source, cfg).getHistory();
    expect(points.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date))).toBe(true);
  });

  it('ignores a key that merely ends in a date, like an unrelated backup object', async () => {
    // Fix D regression: this bucket is a general Argo artifacts bucket
    // written by another repo. `backup-2026-09-01.json` ends in
    // \d{4}-\d{2}-\d{2}\.json but is not one of ours. An unanchored regex
    // would extract "2026-09-01" as a date, and getHistory would then try to
    // fetch `cve-reports/2026-09-01.json` — a key that does not exist —
    // and throw, taking down the whole card (REPORT_UNAVAILABLE) for every
    // component even though the real dated reports are all present and fine.
    const { source } = fakeSource({
      ...objects,
      'cve-reports/backup-2026-09-01.json': report('x', []),
    });
    const points = await new ReportStore(source, cfg).getHistory();
    expect(points.map(p => p.date)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
    ]);
  });
});
