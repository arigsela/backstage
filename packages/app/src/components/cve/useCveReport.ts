/**
 * Resolves an entity's running container images and asks the cve backend what
 * is wrong with them.
 *
 * This hook owns ALL view-state derivation. The card and the table render a
 * state; they never compute one. Keeping the decision here is what guarantees
 * `clean` and `not-scanned` stay distinguishable everywhere they are shown —
 * both mean "no findings returned", and only one of them means safe.
 *
 * The seventh state from the spec, `no-kubernetes`, is a mount guard applied
 * in EntityPage.tsx rather than a value here: this hook only runs where the
 * Kubernetes plugin is available.
 */
import { useEffect, useState } from 'react';
import { useEntity } from '@backstage/plugin-catalog-react';
import { useKubernetesObjects } from '@backstage/plugin-kubernetes-react';

export interface TrendPoint {
  date: string;
  actionable: number;
  /** False when this week's scan did not cover the repo — render as a gap. */
  covered: boolean;
}

export interface Finding {
  id: string;
  pkg: string;
  installed: string;
  fixed: string;
  severity: 'CRITICAL' | 'HIGH';
  title: string;
  image: string;
}

export type CveState =
  | { kind: 'loading' }
  | { kind: 'no-workloads' }
  | { kind: 'not-scanned'; refs: string[] }
  | { kind: 'clean'; scannedAt: string; matchedRefs: string[] }
  | {
      kind: 'data';
      scannedAt: string;
      matchedRefs: string[];
      unmatchedRefs: string[];
      totals: { critical: number; high: number; actionable: number };
      findings: Finding[];
      trend: TrendPoint[];
      /** Change vs the previous covered week. Undefined with <2 covered points. */
      delta?: number;
    }
  | { kind: 'error'; message: string };

/** Pull every running container image out of a Kubernetes objects response. */
export function imagesFromKubernetesObjects(objects: any): string[] {
  const out: string[] = [];
  for (const item of objects?.items ?? []) {
    for (const group of item?.resources ?? []) {
      if (group?.type !== 'pods') continue;
      for (const pod of group?.resources ?? []) {
        const spec = pod?.spec ?? {};
        const containers = [
          ...(spec.containers ?? []),
          ...(spec.initContainers ?? []),
        ];
        for (const c of containers) {
          if (c?.image) out.push(c.image);
        }
      }
    }
  }
  return Array.from(new Set(out));
}

function deltaFrom(trend: TrendPoint[]): number | undefined {
  const covered = trend.filter(p => p.covered);
  if (covered.length < 2) return undefined;
  return (
    covered[covered.length - 1].actionable -
    covered[covered.length - 2].actionable
  );
}

export function useCveReport(): CveState {
  const { entity } = useEntity();
  const { kubernetesObjects, loading, error } = useKubernetesObjects(entity);
  const [state, setState] = useState<CveState>({ kind: 'loading' });

  useEffect(() => {
    if (loading) {
      setState({ kind: 'loading' });
      return undefined;
    }
    if (error) {
      setState({ kind: 'error', message: String(error) });
      return undefined;
    }

    const images = imagesFromKubernetesObjects(kubernetesObjects);
    if (images.length === 0) {
      // Explicitly NOT "no vulnerabilities" — we could not determine the images.
      setState({ kind: 'no-workloads' });
      return undefined;
    }

    let cancelled = false;
    setState({ kind: 'loading' });

    fetch('/api/cve/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    })
      .then(res => res.json())
      .then(body => {
        if (cancelled) return;
        if (!body?.ok) {
          setState({
            kind: 'error',
            message: body?.message ?? 'Could not load vulnerability data',
          });
          return;
        }
        if (body.matchedRefs.length === 0) {
          setState({ kind: 'not-scanned', refs: body.unmatchedRefs ?? images });
          return;
        }
        if (body.totals.actionable === 0) {
          setState({
            kind: 'clean',
            scannedAt: body.scannedAt,
            matchedRefs: body.matchedRefs,
          });
          return;
        }
        setState({
          kind: 'data',
          scannedAt: body.scannedAt,
          matchedRefs: body.matchedRefs,
          unmatchedRefs: body.unmatchedRefs,
          totals: body.totals,
          findings: body.findings,
          trend: body.trend,
          delta: deltaFrom(body.trend ?? []),
        });
      })
      .catch(e => {
        if (!cancelled) {
          setState({ kind: 'error', message: e?.message ?? String(e) });
        }
      });

    return () => {
      cancelled = true;
    };
    // Depend on the *stringified derived image list*, not `kubernetesObjects`
    // itself: useKubernetesObjects polls and hands back a new object identity
    // every tick even when nothing running has changed. Depending on the object
    // would re-fire this effect (and re-hit the cve backend) on every poll;
    // depending on its derived, deduped image list only re-fires when the set
    // of images actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loading,
    error,
    JSON.stringify(imagesFromKubernetesObjects(kubernetesObjects)),
  ]);

  return state;
}
