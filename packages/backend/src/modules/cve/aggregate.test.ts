import {
  normalizeImageRef,
  isActionable,
  dedupeFindings,
  reduceReport,
  historyPointFromRaw,
  summarizeForImages,
  assertRawReport,
} from './aggregate';
import type { RawFinding, RawReport } from './types';

function finding(over: Partial<RawFinding> = {}): RawFinding {
  return {
    image: 'registry.example.com/team/app:v1.0.0',
    id: 'CVE-2026-0001',
    pkg: 'openssl',
    installed: '3.0.11',
    fixed: '3.0.14',
    severity: 'CRITICAL',
    title: 'openssl: something bad',
    ...over,
  };
}

describe('normalizeImageRef', () => {
  it('strips a simple tag', () => {
    expect(normalizeImageRef('team/app:v1.0.0')).toBe('team/app');
  });

  it('strips a digest', () => {
    expect(normalizeImageRef('team/app@sha256:abc123')).toBe('team/app');
  });

  it('strips a tag and a digest together', () => {
    expect(normalizeImageRef('team/app:v1.0.0@sha256:abc123')).toBe('team/app');
  });

  it('does NOT mistake a registry port for a tag', () => {
    // The bug this guard exists to prevent: without it, this returns
    // "registry.local", collapsing every image in that registry into one bucket.
    expect(normalizeImageRef('registry.local:5000/team/app:v1.0.0')).toBe(
      'registry.local:5000/team/app',
    );
  });

  it('leaves an untagged ref with a ported registry alone', () => {
    expect(normalizeImageRef('registry.local:5000/team/app')).toBe(
      'registry.local:5000/team/app',
    );
  });

  it('handles an untagged ref', () => {
    expect(normalizeImageRef('team/app')).toBe('team/app');
  });

  it('treats different tags of one repo as the same repo', () => {
    expect(normalizeImageRef('team/app:v1.4.12')).toBe(
      normalizeImageRef('team/app:v1.4.9'),
    );
  });
});

describe('isActionable', () => {
  it('accepts CRITICAL with a fix', () => {
    expect(
      isActionable(finding({ severity: 'CRITICAL', fixed: '3.0.14' })),
    ).toBe(true);
  });

  it('accepts HIGH with a fix', () => {
    expect(isActionable(finding({ severity: 'HIGH', fixed: '3.0.14' }))).toBe(
      true,
    );
  });

  it('rejects MEDIUM even with a fix', () => {
    expect(isActionable(finding({ severity: 'MEDIUM' }))).toBe(false);
  });

  it('rejects CRITICAL with no fix field', () => {
    expect(isActionable(finding({ fixed: undefined }))).toBe(false);
  });

  it('rejects CRITICAL with an empty fix', () => {
    expect(isActionable(finding({ fixed: '' }))).toBe(false);
  });

  it('rejects a whitespace-only fix', () => {
    expect(isActionable(finding({ fixed: '   ' }))).toBe(false);
  });

  it('is case-insensitive on severity', () => {
    expect(isActionable(finding({ severity: 'critical' }))).toBe(true);
  });
});

describe('reduceReport', () => {
  const raw: RawReport = {
    scanned: ['team/app:v1.0.0', 'team/clean:v2.0.0'],
    failed: [],
    findings: [
      finding({ image: 'team/app:v1.0.0', id: 'CVE-1', severity: 'CRITICAL' }),
      finding({ image: 'team/app:v1.0.0', id: 'CVE-2', severity: 'HIGH' }),
      finding({ image: 'team/app:v1.0.0', id: 'CVE-3', severity: 'MEDIUM' }),
      finding({ image: 'team/app:v1.0.0', id: 'CVE-4', fixed: '' }),
    ],
  };

  it('drops non-actionable findings at reduce time', () => {
    const r = reduceReport(raw);
    expect(r.byRepo.get('team/app')!.map(f => f.id)).toEqual([
      'CVE-1',
      'CVE-2',
    ]);
  });

  it('records a scanned repo that has zero actionable findings', () => {
    const r = reduceReport(raw);
    expect(r.scannedRepos.has('team/clean')).toBe(true);
    expect(r.byRepo.has('team/clean')).toBe(false);
  });

  it('unions two tags of the same repo and dedupes them', () => {
    const r = reduceReport({
      scanned: ['team/app:v1', 'team/app:v2'],
      failed: [],
      findings: [
        finding({ image: 'team/app:v1', id: 'CVE-1' }),
        finding({ image: 'team/app:v2', id: 'CVE-1' }),
        finding({ image: 'team/app:v2', id: 'CVE-9' }),
      ],
    });
    expect(r.byRepo.get('team/app')!.map(f => f.id)).toEqual([
      'CVE-1',
      'CVE-9',
    ]);
  });
});

describe('dedupeFindings', () => {
  it('keys on id + pkg + installed, not on id alone', () => {
    const a = {
      ...finding(),
      id: 'CVE-1',
      pkg: 'openssl',
      installed: '1',
    } as any;
    const b = {
      ...finding(),
      id: 'CVE-1',
      pkg: 'openssl',
      installed: '2',
    } as any;
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });
});

describe('historyPointFromRaw', () => {
  it('counts actionable findings per repo and records coverage', () => {
    const p = historyPointFromRaw('2026-08-17', {
      scanned: ['team/app:v1', 'team/clean:v1'],
      failed: [],
      findings: [
        finding({ image: 'team/app:v1', id: 'CVE-1' }),
        finding({ image: 'team/app:v1', id: 'CVE-2' }),
        finding({ image: 'team/app:v1', id: 'CVE-3', severity: 'LOW' }),
      ],
    });
    expect(p.date).toBe('2026-08-17');
    expect(p.countsByRepo.get('team/app')).toBe(2);
    expect(p.scannedRepos.has('team/clean')).toBe(true);
    expect(p.countsByRepo.has('team/clean')).toBe(false);
  });
});

describe('summarizeForImages', () => {
  const reduced = reduceReport({
    scanned: ['team/app:v1.0.0', 'team/clean:v2.0.0'],
    failed: [],
    findings: [
      finding({ image: 'team/app:v1.0.0', id: 'CVE-1', severity: 'CRITICAL' }),
      finding({ image: 'team/app:v1.0.0', id: 'CVE-2', severity: 'HIGH' }),
    ],
  });

  it('matches a running image on repo path despite a different tag', () => {
    const s = summarizeForImages(reduced, ['team/app:v9.9.9']);
    expect(s.matchedRefs).toEqual(['team/app:v9.9.9']);
    expect(s.unmatchedRefs).toEqual([]);
    expect(s.totals).toEqual({ critical: 1, high: 1, actionable: 2 });
  });

  it('separates a scanned-but-clean repo from an unscanned one', () => {
    const s = summarizeForImages(reduced, ['team/clean:v2', 'team/never:v1']);
    expect(s.matchedRefs).toEqual(['team/clean:v2']);
    expect(s.unmatchedRefs).toEqual(['team/never:v1']);
    expect(s.totals.actionable).toBe(0);
  });

  it('dedupes identical refs from multiple pods', () => {
    const s = summarizeForImages(reduced, [
      'team/app:v1.0.0',
      'team/app:v1.0.0',
    ]);
    expect(s.matchedRefs).toEqual(['team/app:v1.0.0']);
    expect(s.totals.actionable).toBe(2);
  });
});

describe('assertRawReport', () => {
  it('accepts a well-formed report', () => {
    expect(() =>
      assertRawReport({ scanned: [], failed: [], findings: [] }),
    ).not.toThrow();
  });

  it('rejects a truncated report rather than treating it as empty', () => {
    expect(() => assertRawReport({ scanned: [] })).toThrow(/findings/);
    expect(() => assertRawReport(null)).toThrow();
    expect(() => assertRawReport({ scanned: 'nope', findings: [] })).toThrow(
      /scanned/,
    );
  });
});
