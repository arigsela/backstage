import { renderHook, waitFor } from '@testing-library/react';
import { useCveReport, imagesFromKubernetesObjects } from './useCveReport';

const mockUseKubernetesObjects = jest.fn();
jest.mock('@backstage/plugin-kubernetes-react', () => ({
  useKubernetesObjects: (...args: any[]) => mockUseKubernetesObjects(...args),
}));
jest.mock('@backstage/plugin-catalog-react', () => ({
  useEntity: () => ({ entity: { metadata: { name: 'app' } } }),
}));

function k8sWithImages(images: string[]) {
  return {
    kubernetesObjects: {
      items: [
        {
          cluster: { name: 'homelab' },
          resources: [
            {
              type: 'pods',
              resources: [
                { spec: { containers: images.map(image => ({ image })) } },
              ],
            },
          ],
        },
      ],
    },
    loading: false,
    error: undefined,
  };
}

function okResponse(body: any) {
  return { ok: true, status: 200, json: async () => body } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

describe('imagesFromKubernetesObjects', () => {
  it('collects containers and initContainers, deduped', () => {
    const objects = {
      items: [
        {
          resources: [
            {
              type: 'pods',
              resources: [
                {
                  spec: {
                    containers: [{ image: 'a:1' }, { image: 'b:1' }],
                    initContainers: [{ image: 'c:1' }],
                  },
                },
                { spec: { containers: [{ image: 'a:1' }] } },
              ],
            },
          ],
        },
      ],
    };
    expect(imagesFromKubernetesObjects(objects).sort()).toEqual([
      'a:1',
      'b:1',
      'c:1',
    ]);
  });

  it('ignores non-pod resource groups', () => {
    const objects = {
      items: [{ resources: [{ type: 'services', resources: [{ spec: {} }] }] }],
    };
    expect(imagesFromKubernetesObjects(objects)).toEqual([]);
  });

  it('survives missing fields', () => {
    expect(imagesFromKubernetesObjects(undefined)).toEqual([]);
    expect(imagesFromKubernetesObjects({ items: [{}] })).toEqual([]);
  });
});

describe('useCveReport', () => {
  it('is loading while kubernetes objects load', () => {
    mockUseKubernetesObjects.mockReturnValue({ loading: true });
    const { result } = renderHook(() => useCveReport());
    expect(result.current.kind).toBe('loading');
  });

  it('reports no-workloads when there are no pods', async () => {
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages([]));
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('no-workloads'));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reports not-scanned when no image matched', async () => {
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['team/never:v1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: true,
        scannedAt: '2026-08-17',
        matchedRefs: [],
        unmatchedRefs: ['team/never:v1'],
        totals: { critical: 0, high: 0, actionable: 0 },
        findings: [],
        trend: [],
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('not-scanned'));
    expect((result.current as any).refs).toEqual(['team/never:v1']);
  });

  it('reports clean when the image was scanned with zero actionable', async () => {
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['team/app:v1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: true,
        scannedAt: '2026-08-17',
        matchedRefs: ['team/app:v1'],
        unmatchedRefs: [],
        totals: { critical: 0, high: 0, actionable: 0 },
        findings: [],
        trend: [],
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('clean'));
  });

  it('distinguishes clean from not-scanned', async () => {
    // The single most important assertion in this file: both are "no findings",
    // only one means safe.
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['a:1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: true,
        scannedAt: '2026-08-17',
        matchedRefs: [],
        unmatchedRefs: ['a:1'],
        totals: { critical: 0, high: 0, actionable: 0 },
        findings: [],
        trend: [],
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).not.toBe('loading'));
    expect(result.current.kind).toBe('not-scanned');
  });

  it('reports data with totals and trend when findings exist', async () => {
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['team/app:v1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: true,
        scannedAt: '2026-08-17',
        matchedRefs: ['team/app:v1'],
        unmatchedRefs: [],
        totals: { critical: 41, high: 155, actionable: 196 },
        findings: [
          {
            id: 'CVE-1',
            pkg: 'openssl',
            installed: '1',
            fixed: '2',
            severity: 'CRITICAL',
            title: 't',
            image: 'team/app:v1',
          },
        ],
        trend: [
          { date: '2026-08-10', actionable: 208, covered: true },
          { date: '2026-08-17', actionable: 196, covered: true },
        ],
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('data'));
    const s = result.current as any;
    expect(s.totals.actionable).toBe(196);
    expect(s.delta).toBe(-12);
    expect(s.trendReady).toBe(true);
  });

  it('leaves delta undefined when the scan immediately before the latest is a gap', async () => {
    // Finding 4 fix (supersedes the 9e8873b hardening test this replaces):
    // the previous semantics skipped past the uncovered midpoint and diffed
    // the two covered points on either side of it (208 -> 196, delta -12),
    // then labelled that "vs last scan" — a real number attached to a false
    // claim, since the actual last scan (2026-08-10) never covered this repo.
    // Delta must now be undefined whenever the final two trend entries are
    // not BOTH covered, regardless of what an earlier scan saw.
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['team/app:v1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: true,
        scannedAt: '2026-08-17',
        matchedRefs: ['team/app:v1'],
        unmatchedRefs: [],
        totals: { critical: 41, high: 155, actionable: 196 },
        findings: [
          {
            id: 'CVE-1',
            pkg: 'openssl',
            installed: '1',
            fixed: '2',
            severity: 'CRITICAL',
            title: 't',
            image: 'team/app:v1',
          },
        ],
        trend: [
          { date: '2026-08-03', actionable: 208, covered: true },
          { date: '2026-08-10', actionable: 0, covered: false },
          { date: '2026-08-17', actionable: 196, covered: true },
        ],
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('data'));
    expect((result.current as any).delta).toBeUndefined();
  });

  it('marks trend not ready to chart when covered points are scattered, not adjacent', async () => {
    // Two covered points exist here — enough to satisfy the old, wrong
    // "covered.length >= 2" readiness check — but neither is adjacent to the
    // other, so Sparkline cannot draw a single segment from this data.
    // trendReady must track what can actually be drawn, not just a count.
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['team/app:v1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: true,
        scannedAt: '2026-08-17',
        matchedRefs: ['team/app:v1'],
        unmatchedRefs: [],
        totals: { critical: 1, high: 0, actionable: 1 },
        findings: [],
        trend: [
          { date: '2026-07-27', actionable: 3, covered: true },
          { date: '2026-08-03', actionable: 0, covered: false },
          { date: '2026-08-10', actionable: 2, covered: true },
          { date: '2026-08-17', actionable: 1, covered: false },
        ],
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('data'));
    expect((result.current as any).trendReady).toBe(false);
  });

  it('leaves delta undefined with fewer than two covered points', async () => {
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['team/app:v1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: true,
        scannedAt: '2026-08-17',
        matchedRefs: ['team/app:v1'],
        unmatchedRefs: [],
        totals: { critical: 1, high: 0, actionable: 1 },
        findings: [
          {
            id: 'CVE-1',
            pkg: 'p',
            installed: '1',
            fixed: '2',
            severity: 'CRITICAL',
            title: 't',
            image: 'team/app:v1',
          },
        ],
        trend: [{ date: '2026-08-17', actionable: 1, covered: true }],
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('data'));
    expect((result.current as any).delta).toBeUndefined();
  });

  it('surfaces a backend failure as error, never as zero', async () => {
    mockUseKubernetesObjects.mockReturnValue(k8sWithImages(['team/app:v1']));
    (global.fetch as jest.Mock).mockResolvedValue(
      okResponse({
        ok: false,
        code: 'REPORT_UNAVAILABLE',
        message: 'AccessDenied',
      }),
    );
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('error'));
    expect((result.current as any).message).toMatch(/AccessDenied/);
  });

  it('surfaces a kubernetes error as error', async () => {
    mockUseKubernetesObjects.mockReturnValue({
      loading: false,
      error: 'cluster unreachable',
      kubernetesObjects: undefined,
    });
    const { result } = renderHook(() => useCveReport());
    await waitFor(() => expect(result.current.kind).toBe('error'));
  });
});
