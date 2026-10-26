/**
 * scorecard-cve: adds the CVE cards to the RHDH Scorecard.
 *
 * A scorecard backend module (pluginId 'scorecard') that registers one
 * provider, `cve.scan`, with four metrics (see metrics.ts). It reads the same
 * S3 report as the cve plugin through its own ReportStore (one cached copy per
 * plugin, refreshed at most hourly) and asks the Kubernetes plugin which
 * images each entity runs. Schedule: scorecard.metricProviders.cve.scan in
 * app-config.yaml (daily).
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { scorecardMetricsExtensionPoint } from '@red-hat-developer-hub/backstage-plugin-scorecard-node';
import { readCveConfig } from '../cve/config';
import { ReportStore } from '../cve/reportStore';
import { createS3ReportSource } from '../cve/s3Client';
import { kubernetesImageSource } from './images';
import { CveMetricProvider } from './provider';

const scorecardModuleCve = createBackendModule({
  pluginId: 'scorecard',
  moduleId: 'cve',
  register(reg) {
    reg.registerInit({
      deps: {
        metrics: scorecardMetricsExtensionPoint,
        config: coreServices.rootConfig,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
      },
      async init({ metrics, config, discovery, auth }) {
        const cfg = readCveConfig(config);
        metrics.addMetricProvider(
          new CveMetricProvider({
            store: new ReportStore(createS3ReportSource(cfg), cfg),
            images: kubernetesImageSource({ discovery, auth }),
          }),
        );
      },
    });
  },
});

export default scorecardModuleCve;
