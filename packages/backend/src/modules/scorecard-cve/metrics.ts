/**
 * The four CVE cards on an entity's Scorecard tab.
 *
 * Red means "a new image fixes this": a critical with a fix, or anything on
 * CISA's actively-exploited (KEV) list with a fix. Amber is for awareness
 * only: criticals with no fix yet, and running images the weekly scan has not
 * seen. Non-exploited highs, mediums and lows get no card (the Security tab
 * still lists fixable criticals and highs).
 */
import type {
  Metric,
  ThresholdConfig,
} from '@red-hat-developer-hub/backstage-plugin-scorecard-common';

export const CVE_DATASOURCE = 'cve';
/** Scheduler task id and config key: scorecard.metricProviders.cve.scan. */
export const CVE_PROVIDER_ID = 'cve.scan';

const ACT_ON: ThresholdConfig = {
  rules: [
    { key: 'success', expression: '<1' },
    { key: 'error', expression: '>=1' },
  ],
};

const AWARENESS: ThresholdConfig = {
  rules: [
    { key: 'success', expression: '<1' },
    { key: 'warning', expression: '>=1' },
  ],
};

const SOURCE =
  'From the weekly Trivy scan (Sundays 04:00 UTC) of the images this component runs.';

export const CVE_METRICS: Metric<'number'>[] = [
  {
    id: 'cve.criticalFixable',
    title: 'Critical CVEs with a fix',
    description: `Critical CVEs that a rebuilt or newer image fixes. ${SOURCE}`,
    type: 'number',
    thresholds: ACT_ON,
    history: true,
  },
  {
    id: 'cve.kevFixable',
    title: 'Actively exploited CVEs with a fix',
    description: `CVEs on CISA's Known Exploited Vulnerabilities list, at any severity, that a rebuilt or newer image fixes. ${SOURCE}`,
    type: 'number',
    thresholds: ACT_ON,
    history: true,
  },
  {
    id: 'cve.criticalNoFix',
    title: 'Critical CVEs with no fix yet',
    description: `Critical CVEs with no fixed version upstream yet, for awareness: a new image does not help. ${SOURCE}`,
    type: 'number',
    thresholds: AWARENESS,
    history: true,
  },
  {
    id: 'cve.imagesNotScanned',
    title: 'Images not scanned yet',
    description:
      'Running images the latest weekly scan did not cover, usually ones deployed since. Their CVEs are missing from the other cards until the next scan.',
    type: 'number',
    thresholds: AWARENESS,
    history: true,
  },
];
