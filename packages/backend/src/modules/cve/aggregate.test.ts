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

  it('counts an unowned upstream image, unlike the Slack alert', () => {
    // The Slack alert's canonical actionable() additionally requires the
    // image to be under our owned ECR prefix ("852893458518.dkr.ecr.") so it
    // doesn't page us about images we cannot rebuild ourselves. We
    // deliberately do NOT apply that filter here: an upstream image like this
    // one can still carry a real, fixable CRITICAL, and hiding it would
    // render the component falsely "clean". Do not "fix" this test to match
    // the Slack alert's three-clause rule — see the WHY-comment on
    // isActionable and spec §5.
    expect(
      isActionable(
        finding({
          image: 'quay.io/jetstack/cert-manager-webhook:v1.20.2',
          severity: 'CRITICAL',
          fixed: '1.20.3',
        }),
      ),
    ).toBe(true);
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

  it('throws on a malformed report rather than silently reducing to zero findings', () => {
    // Simulates a caller reaching reduceReport without going through
    // assertRawReport first. The type system would normally forbid passing an
    // object missing `findings`, hence the `as any` — this is exercising the
    // runtime guard that exists precisely for callers that bypass the type.
    expect(() => reduceReport({ scanned: [] } as any)).toThrow(/findings/);
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

describe('reduceReport KEV coverage', () => {
  it('marks KEV as checked when every finding carries a true/false flag', () => {
    const r = reduceReport({
      scanned: ['team/app:v1'],
      failed: [],
      findings: [
        finding({ image: 'team/app:v1', kev: false }),
        finding({ image: 'team/app:v1', id: 'CVE-2', kev: true }),
      ],
    });
    expect(r.kevChecked).toBe(true);
  });

  it('marks KEV as unchecked when the feed was down (kev: null) or absent', () => {
    for (const kev of [null, undefined]) {
      const r = reduceReport({
        scanned: ['team/app:v1'],
        failed: [],
        findings: [
          finding({ image: 'team/app:v1', kev: false }),
          finding({ image: 'team/app:v1', id: 'CVE-2', kev }),
        ],
      });
      expect(r.kevChecked).toBe(false);
    }
  });
});

describe('summarizeForImages', () => {
  const APP = 'team/app:v1.0.0@sha256:aaa';
  const reduced = reduceReport({
    scanned: [APP, 'team/clean:v2.0.0', 'team/old:v1'],
    failed: [],
    findings: [
      finding({ image: APP, id: 'CVE-1', severity: 'CRITICAL' }),
      finding({ image: APP, id: 'CVE-2', severity: 'HIGH' }),
      // critical, no fix yet: not actionable, counted for awareness
      finding({ image: APP, id: 'CVE-3', severity: 'CRITICAL', fixed: '' }),
      // actively exploited (KEV) with a fix, at MEDIUM: counts as KEV-fixable
      finding({ image: APP, id: 'CVE-4', severity: 'MEDIUM', kev: true }),
      // actively exploited but no fix: not KEV-fixable
      finding({
        image: APP,
        id: 'CVE-5',
        severity: 'HIGH',
        kev: true,
        fixed: '',
      }),
      finding({ image: 'team/old:v1', id: 'CVE-9', severity: 'CRITICAL' }),
    ],
  });
  const APP_TOTALS = {
    critical: 1,
    high: 1,
    actionable: 2,
    criticalNoFix: 1,
    kevFixable: 1,
  };

  it('matches the exact scanned ref and counts every card', () => {
    const s = summarizeForImages(reduced, [APP]);
    expect(s.matchedRefs).toEqual([APP]);
    expect(s.unmatchedRefs).toEqual([]);
    expect(s.totals).toEqual(APP_TOTALS);
  });

  it('matches on digest when the running ref is written differently', () => {
    for (const ref of ['team/app@sha256:aaa', 'team/app:latest@sha256:aaa']) {
      const s = summarizeForImages(reduced, [ref]);
      expect(s.matchedRefs).toEqual([ref]);
      expect(s.totals).toEqual(APP_TOTALS);
    }
  });

  it('does not borrow findings from another version of the same repo', () => {
    // The weekly scan saw team/old:v1; the cluster now runs v2. Reporting
    // v1's CVE-9 against v2 is the bug this guards (hk-demo v0.5.0 vs v0.7.0).
    const s = summarizeForImages(reduced, ['team/old:v2']);
    expect(s.matchedRefs).toEqual([]);
    expect(s.unmatchedRefs).toEqual(['team/old:v2']);
    expect(s.totals.critical).toBe(0);
  });

  it('does not match a different digest of the same tag', () => {
    const s = summarizeForImages(reduced, ['team/app:v1.0.0@sha256:bbb']);
    expect(s.unmatchedRefs).toEqual(['team/app:v1.0.0@sha256:bbb']);
  });

  it('separates a scanned-but-clean image from an unscanned one', () => {
    const s = summarizeForImages(reduced, [
      'team/clean:v2.0.0',
      'team/never:v1',
    ]);
    expect(s.matchedRefs).toEqual(['team/clean:v2.0.0']);
    expect(s.unmatchedRefs).toEqual(['team/never:v1']);
    expect(s.totals.actionable).toBe(0);
  });

  it('dedupes identical refs from multiple pods', () => {
    const s = summarizeForImages(reduced, [APP, APP]);
    expect(s.matchedRefs).toEqual([APP]);
    expect(s.totals).toEqual(APP_TOTALS);
  });

  it('counts a CVE shared by two images of one component once', () => {
    const two = reduceReport({
      scanned: ['team/a:v1', 'team/b:v1'],
      failed: [],
      findings: [
        finding({ image: 'team/a:v1', id: 'CVE-7', fixed: '' }),
        finding({ image: 'team/b:v1', id: 'CVE-7', fixed: '' }),
        finding({ image: 'team/a:v1', id: 'CVE-8', kev: true }),
        finding({ image: 'team/b:v1', id: 'CVE-8', kev: true }),
      ],
    });
    const s = summarizeForImages(two, ['team/a:v1', 'team/b:v1']);
    expect(s.totals.criticalNoFix).toBe(1);
    expect(s.totals.kevFixable).toBe(1);
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
