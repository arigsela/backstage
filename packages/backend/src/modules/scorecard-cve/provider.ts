/**
 * Scorecard metric provider for the CVE cards.
 *
 * Per entity: the running images (Kubernetes plugin), matched by exact ref or
 * digest against the weekly scan report (the cve module's ReportStore and
 * summarizeForImages, so the cards, the Security tab and the readiness skill
 * agree). Cheap by design, unlike v1.6.0's filecheck: one shared cached
 * report, and at most `concurrency` Kubernetes lookups at a time even though
 * the scorecard calculates a batch of 50 entities at once.
 */
import type { Entity } from '@backstage/catalog-model';
import { CATALOG_FILTER_EXISTS } from '@backstage/catalog-client';
import type { MetricProvider } from '@red-hat-developer-hub/backstage-plugin-scorecard-node';
import type { Metric } from '@red-hat-developer-hub/backstage-plugin-scorecard-common';
import { summarizeForImages } from '../cve/aggregate';
import type { ReducedReport } from '../cve/types';
import type { ImageSource } from './images';
import { CVE_DATASOURCE, CVE_METRICS, CVE_PROVIDER_ID } from './metrics';

const DEFAULT_CONCURRENCY = 2;

/** Run at most `max` calls at once; a freed slot goes straight to the next waiter. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active < max) active += 1;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export class CveMetricProvider implements MetricProvider<'number'> {
  private readonly limit: ReturnType<typeof createLimiter>;

  constructor(
    private readonly opts: {
      store: {
        getLatest(): Promise<{ date: string; reduced: ReducedReport }>;
      };
      images: ImageSource;
      concurrency?: number;
    },
  ) {
    this.limit = createLimiter(opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  getProviderDatasourceId(): string {
    return CVE_DATASOURCE;
  }

  getProviderId(): string {
    return CVE_PROVIDER_ID;
  }

  getMetrics(): Metric<'number'>[] {
    return CVE_METRICS;
  }

  /**
   * Entities with either Kubernetes annotation (33 use the label selector, 7
   * kubernetes-id). The interface types a single filter object, which can
   * only AND; the scheduler hands it straight to catalog.queryEntities, which
   * also takes an array of filters and ORs them.
   */
  getCatalogFilter(): Record<string, string | symbol | (string | symbol)[]> {
    return [
      {
        'metadata.annotations.backstage.io/kubernetes-label-selector':
          CATALOG_FILTER_EXISTS,
      },
      {
        'metadata.annotations.backstage.io/kubernetes-id':
          CATALOG_FILTER_EXISTS,
      },
    ] as unknown as Record<string, string | symbol | (string | symbol)[]>;
  }

  async calculateMetrics(entity: Entity): Promise<Map<string, number>> {
    const images = await this.limit(() => this.opts.images(entity));
    if (images.length === 0) {
      // Zeros would read as "clean"; an error reads as "we don't know".
      throw new Error('no running pods found in Kubernetes for this entity');
    }
    const { reduced } = await this.opts.store.getLatest();
    const s = summarizeForImages(reduced, images);
    return new Map<string, number>([
      ['cve.criticalFixable', s.totals.critical],
      ['cve.kevFixable', s.totals.kevFixable],
      ['cve.criticalNoFix', s.totals.criticalNoFix],
      ['cve.imagesNotScanned', s.unmatchedRefs.length],
    ]);
  }
}
