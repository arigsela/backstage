import type { Entity } from '@backstage/catalog-model';
import { imagesFromKubernetesObjects, kubernetesImageSource } from './images';

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'hk-demo',
    namespace: 'hk-demo',
    annotations: { 'backstage.io/kubernetes-label-selector': 'app=hk-demo' },
  },
  spec: {},
};

function pods(...specs: any[]) {
  return {
    items: [
      {
        cluster: { name: 'homelab' },
        errors: [],
        resources: [
          { type: 'services', resources: [{ spec: { containers: [] } }] },
          { type: 'pods', resources: specs.map(spec => ({ spec })) },
        ],
      },
    ],
  };
}

describe('imagesFromKubernetesObjects', () => {
  it('collects container and init container images from pods only, deduped', () => {
    const objects = pods(
      {
        containers: [{ image: 'team/app:v1' }, { image: 'team/proxy:v7' }],
        initContainers: [{ image: 'busybox:1.36' }],
      },
      { containers: [{ image: 'team/app:v1' }] },
    );
    expect(imagesFromKubernetesObjects(objects)).toEqual([
      'team/app:v1',
      'team/proxy:v7',
      'busybox:1.36',
    ]);
  });

  it('returns nothing for an empty or malformed response', () => {
    expect(imagesFromKubernetesObjects(undefined)).toEqual([]);
    expect(imagesFromKubernetesObjects({ items: [{}] })).toEqual([]);
  });
});

describe('kubernetesImageSource', () => {
  const discovery = {
    getBaseUrl: jest.fn(async () => 'http://backend/api/kubernetes'),
  } as any;
  const auth = {
    getOwnServiceCredentials: jest.fn(async () => ({ principal: 'svc' })),
    getPluginRequestToken: jest.fn(async () => ({ token: 'svc-token' })),
  } as any;

  function respond(status: number, body: unknown) {
    return jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as any;
  }

  it('asks the kubernetes backend for the entity, with a service token', async () => {
    const fetchFn = respond(
      200,
      pods({ containers: [{ image: 'team/app:v1' }] }),
    );
    const images = await kubernetesImageSource({ discovery, auth, fetchFn })(
      entity,
    );
    expect(images).toEqual(['team/app:v1']);
    expect(auth.getPluginRequestToken).toHaveBeenCalledWith({
      onBehalfOf: { principal: 'svc' },
      targetPluginId: 'kubernetes',
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://backend/api/kubernetes/services/hk-demo');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');
    expect(JSON.parse(init.body)).toEqual({ entity });
  });

  it('gives up on a lookup that hangs', async () => {
    // A slow kube API must not hold a scorecard slot (and the run) open.
    const fetchFn = jest.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(init.signal.reason),
          );
        }),
    ) as any;
    await expect(
      kubernetesImageSource({ discovery, auth, fetchFn, timeoutMs: 20 })(
        entity,
      ),
    ).rejects.toThrow('kubernetes lookup timed out after 20 ms');
  });

  it('throws on a non-2xx answer', async () => {
    const fetchFn = respond(500, { error: 'boom' });
    await expect(
      kubernetesImageSource({ discovery, auth, fetchFn })(entity),
    ).rejects.toThrow('HTTP 500');
  });

  it('throws the cluster errors when no pods came back because of them', async () => {
    const fetchFn = respond(200, {
      items: [
        {
          cluster: { name: 'homelab' },
          errors: [
            { errorType: 'UNAUTHORIZED_ERROR', resourcePath: '/api/v1/pods' },
          ],
          resources: [],
        },
      ],
    });
    await expect(
      kubernetesImageSource({ discovery, auth, fetchFn })(entity),
    ).rejects.toThrow('UNAUTHORIZED_ERROR');
  });
});
