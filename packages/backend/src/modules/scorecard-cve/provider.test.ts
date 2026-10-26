import type { Entity } from '@backstage/catalog-model';
import { CATALOG_FILTER_EXISTS } from '@backstage/catalog-client';
import { reduceReport } from '../cve/aggregate';
import type { RawFinding } from '../cve/types';
import { CveMetricProvider, createLimiter } from './provider';

function entity(name: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name, namespace: 'default' },
    spec: {},
  };
}

function finding(over: Partial<RawFinding>): RawFinding {
  return {
    image: 'team/app:v1',
    id: 'CVE-1',
    pkg: 'openssl',
    installed: '3.0.11',
    fixed: '3.0.14',
    severity: 'CRITICAL',
    title: 't',
    ...over,
  };
}

const reduced = reduceReport({
  scanned: ['team/app:v1'],
  failed: [],
  findings: [
    finding({ id: 'CVE-1' }),
    finding({ id: 'CVE-2', fixed: '' }),
    finding({ id: 'CVE-3', severity: 'LOW', kev: true }),
    finding({ id: 'CVE-4', severity: 'HIGH' }),
  ],
});

function store() {
  return {
    getLatest: jest.fn(async () => ({ date: '2026-10-25', reduced })),
  };
}

describe('CveMetricProvider', () => {
  it('maps the running images to the four card values', async () => {
    const provider = new CveMetricProvider({
      store: store(),
      images: async () => ['team/app:v1', 'team/new:v2'],
    });
    const values = await provider.calculateMetrics(entity('app'));
    expect(Object.fromEntries(values)).toEqual({
      'cve.criticalFixable': 1,
      'cve.kevFixable': 1,
      'cve.criticalNoFix': 1,
      'cve.imagesNotScanned': 1,
    });
  });

  it('fails the entity rather than reporting zeros when no pods are running', async () => {
    const provider = new CveMetricProvider({
      store: store(),
      images: async () => [],
    });
    await expect(provider.calculateMetrics(entity('app'))).rejects.toThrow(
      'no running pods',
    );
  });

  it('selects entities with either Kubernetes annotation', () => {
    const provider = new CveMetricProvider({
      store: store(),
      images: async () => [],
    });
    expect(provider.getCatalogFilter()).toEqual([
      {
        'metadata.annotations.backstage.io/kubernetes-label-selector':
          CATALOG_FILTER_EXISTS,
      },
      {
        'metadata.annotations.backstage.io/kubernetes-id':
          CATALOG_FILTER_EXISTS,
      },
    ]);
  });

  it('asks Kubernetes for at most `concurrency` entities at a time', async () => {
    // The scorecard calculates a batch of up to 50 entities at once.
    let inFlight = 0;
    let peak = 0;
    const provider = new CveMetricProvider({
      store: store(),
      concurrency: 2,
      images: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight -= 1;
        return ['team/app:v1'];
      },
    });
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        provider.calculateMetrics(entity(`e${i}`)),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe('createLimiter', () => {
  it('keeps running queued work after a failure', async () => {
    const limit = createLimiter(1);
    const failed = limit(async () => {
      throw new Error('boom');
    });
    const ok = limit(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(ok).resolves.toBe('ok');
  });
});
