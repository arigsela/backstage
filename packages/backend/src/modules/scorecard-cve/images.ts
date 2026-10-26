/**
 * Which images an entity runs, from the Kubernetes plugin: the same answer
 * the Security tab gets in the browser (useKubernetesObjects), asked from the
 * backend with a service token.
 */
import type {
  AuthService,
  DiscoveryService,
} from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';

export type ImageSource = (entity: Entity) => Promise<string[]>;

/**
 * Every container and init container image in the response's pods, deduped.
 * Mirrors imagesFromKubernetesObjects in
 * packages/app/src/components/cve/useCveReport.ts; keep the two in step.
 */
export function imagesFromKubernetesObjects(objects: any): string[] {
  const out: string[] = [];
  for (const item of objects?.items ?? []) {
    for (const group of item?.resources ?? []) {
      if (group?.type !== 'pods') continue;
      for (const pod of group?.resources ?? []) {
        const spec = pod?.spec ?? {};
        for (const c of [
          ...(spec.containers ?? []),
          ...(spec.initContainers ?? []),
        ]) {
          if (c?.image) out.push(c.image);
        }
      }
    }
  }
  return Array.from(new Set(out));
}

function clusterErrors(objects: any): string[] {
  const out: string[] = [];
  for (const item of objects?.items ?? []) {
    for (const e of item?.errors ?? []) {
      const where = e?.resourcePath ? ` ${e.resourcePath}` : '';
      out.push(`${item?.cluster?.name ?? 'cluster'}: ${e?.errorType}${where}`);
    }
  }
  return out;
}

/** Per-lookup limit: 40 entities at 2 at a time stay well inside the 10-minute task timeout. */
const DEFAULT_TIMEOUT_MS = 20_000;

export function kubernetesImageSource(opts: {
  discovery: Pick<DiscoveryService, 'getBaseUrl'>;
  auth: Pick<AuthService, 'getOwnServiceCredentials' | 'getPluginRequestToken'>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): ImageSource {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async entity => {
    const base = await opts.discovery.getBaseUrl('kubernetes');
    const { token } = await opts.auth.getPluginRequestToken({
      onBehalfOf: await opts.auth.getOwnServiceCredentials(),
      targetPluginId: 'kubernetes',
    });
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(
        `${base}/services/${encodeURIComponent(entity.metadata.name)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ entity }),
          signal,
        },
      );
    } catch (e) {
      if (signal.aborted) {
        throw new Error(`kubernetes lookup timed out after ${timeoutMs} ms`);
      }
      throw e;
    }
    if (!res.ok) {
      throw new Error(`kubernetes backend answered HTTP ${res.status}`);
    }
    const body = await res.json();
    const images = imagesFromKubernetesObjects(body);
    if (images.length === 0) {
      // No pods because a cluster call failed is not "no pods".
      const errors = clusterErrors(body);
      if (errors.length > 0) {
        throw new Error(`kubernetes errors: ${errors.join('; ')}`);
      }
    }
    return images;
  };
}
