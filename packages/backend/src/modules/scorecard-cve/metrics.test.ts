import { validateThresholdsForMetric } from '@red-hat-developer-hub/backstage-plugin-scorecard-node';
import { CVE_DATASOURCE, CVE_METRICS, CVE_PROVIDER_ID } from './metrics';

describe('CVE scorecard metrics', () => {
  it('defines the four cards, in display order', () => {
    expect(CVE_METRICS.map(m => m.id)).toEqual([
      'cve.criticalFixable',
      'cve.kevFixable',
      'cve.criticalNoFix',
      'cve.imagesNotScanned',
    ]);
  });

  it('uses ids the scorecard registry accepts (<datasource>.<name>)', () => {
    expect(CVE_PROVIDER_ID).toBe(`${CVE_DATASOURCE}.scan`);
    for (const m of CVE_METRICS) {
      expect(m.id.split('.')).toEqual([CVE_DATASOURCE, expect.any(String)]);
      expect(m.type).toBe('number');
    }
  });

  it('has thresholds the scorecard registry accepts', () => {
    for (const m of CVE_METRICS) {
      expect(() =>
        validateThresholdsForMetric(m.thresholds, m.type),
      ).not.toThrow();
    }
  });

  it('turns red only for what a new image fixes; awareness cards stop at amber', () => {
    const keys = (id: string) =>
      CVE_METRICS.find(m => m.id === id)!.thresholds.rules.map(r => r.key);
    expect(keys('cve.criticalFixable')).toEqual(['success', 'error']);
    expect(keys('cve.kevFixable')).toEqual(['success', 'error']);
    expect(keys('cve.criticalNoFix')).toEqual(['success', 'warning']);
    expect(keys('cve.imagesNotScanned')).toEqual(['success', 'warning']);
  });
});
