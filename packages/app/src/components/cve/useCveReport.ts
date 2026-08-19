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
import { useEffect, useRef, useState } from 'react';
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
  | {
      kind: 'clean';
      scannedAt: string;
      matchedRefs: string[];
      /**
       * Images this component runs that the scan did NOT cover. A component
       * can run two images — one scanned-and-clean, one never scanned — and
       * that combination must never render as an unqualified "No actionable
       * vulnerabilities": the unscanned image could hide anything. Carrying
       * this through is what lets the card and table caveat the claim instead
       * of dropping it, which is exactly the false-clean this feature exists
       * to prevent (see CveSummaryCard / CveFindingsTable).
       */
      unmatchedRefs: string[];
    }
  | {
      kind: 'data';
      scannedAt: string;
      matchedRefs: string[];
      unmatchedRefs: string[];
      totals: { critical: number; high: number; actionable: number };
      findings: Finding[];
      trend: TrendPoint[];
      /**
       * Whether `trend` contains at least one pair of index-adjacent covered
       * weeks — exactly the condition under which Sparkline can draw a
       * segment. This is a view-readiness decision, computed once here so
       * the card never has to (and can't drift from what the chart can
       * actually render). A looser test like "two covered points anywhere"
       * can be true while every covered point is isolated by gaps, which
       * left the card rendering a blank `<svg>` instead of the "trend
       * needs another scan" fallback.
       */
      trendReady: boolean;
      /**
       * Change vs the immediately preceding scan. Defined ONLY when the
       * final two trend entries are both covered — comparing against a scan
       * that did not cover this repo would produce a real number with a
       * false label ("vs last scan" when the last scan skipped this repo).
       */
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

/**
 * True when at least one pair of index-adjacent trend entries are both
 * covered. This mirrors Sparkline's own segment-building rule (a run needs
 * >= 2 consecutive covered points to draw a line) so the readiness flag can
 * never say "yes" when the chart would actually render nothing.
 */
function hasAdjacentCoveredPair(trend: TrendPoint[]): boolean {
  for (let i = 0; i < trend.length - 1; i++) {
    if (trend[i].covered && trend[i + 1].covered) return true;
  }
  return false;
}

function deltaFrom(trend: TrendPoint[]): number | undefined {
  if (trend.length < 2) return undefined;
  const last = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  // Both entries must be covered: diffing across an uncovered gap produces a
  // real-looking number attached to a false "vs last scan" claim.
  if (!last.covered || !prev.covered) return undefined;
  return last.actionable - prev.actionable;
}

/**
 * How often to re-poll Kubernetes for this entity's running images.
 *
 * Deliberately one hour, matching the backend's `cve.cacheTtlMinutes`. The
 * underlying report is regenerated once a week by a Sunday cron, and the
 * backend serves `latest.json` from an in-memory cache for an hour, so polling
 * faster than that cannot surface newer data — it only costs requests and, via
 * the `loading` toggle below, makes the card flicker. `useKubernetesObjects`
 * defaults to 10s, which is right for a live pod-status view and wrong here.
 */
const POLL_INTERVAL_MS = 60 * 60 * 1000;

export function useCveReport(): CveState {
  const { entity } = useEntity();
  const { kubernetesObjects, loading, error } = useKubernetesObjects(
    entity,
    POLL_INTERVAL_MS,
  );
  const [state, setState] = useState<CveState>({ kind: 'loading' });
  // Tracks whether we have ever produced a terminal state. Once we have, a
  // subsequent poll must NOT blank the card back to a skeleton — it keeps the
  // previous result on screen while revalidating. Without this the card
  // visibly empties on every refresh, which reads as "the data went away".
  const hasResolved = useRef(false);

  // Depend on the *stringified derived image list*, not `kubernetesObjects`
  // itself: useKubernetesObjects polls and hands back a new object identity
  // every tick even when nothing running has changed. Depending on the object
  // would re-fire this effect (and re-hit the cve backend) on every poll;
  // depending on its derived, deduped image list only re-fires when the set
  // of images actually changes. Computing it here (rather than inside the
  // effect) means the effect body never references `kubernetesObjects`
  // directly, so exhaustive-deps has nothing to flag and needs no disable.
  const imagesKey = JSON.stringify(
    imagesFromKubernetesObjects(kubernetesObjects),
  );

  useEffect(() => {
    if (loading) {
      // Skeleton only on first load; later polls keep the last result visible.
      if (!hasResolved.current) setState({ kind: 'loading' });
      return undefined;
    }
    if (error) {
      hasResolved.current = true;
      setState({ kind: 'error', message: String(error) });
      return undefined;
    }

    const images: string[] = JSON.parse(imagesKey);
    if (images.length === 0) {
      // Explicitly NOT "no vulnerabilities" — we could not determine the images.
      hasResolved.current = true;
      setState({ kind: 'no-workloads' });
      return undefined;
    }

    let cancelled = false;
    if (!hasResolved.current) setState({ kind: 'loading' });

    fetch('/api/cve/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    })
      .then(res => res.json())
      .then(body => {
        if (cancelled) return;
        hasResolved.current = true;
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
            unmatchedRefs: body.unmatchedRefs ?? [],
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
          trendReady: hasAdjacentCoveredPair(body.trend ?? []),
          delta: deltaFrom(body.trend ?? []),
        });
      })
      .catch(e => {
        if (!cancelled) {
          hasResolved.current = true;
          setState({ kind: 'error', message: e?.message ?? String(e) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loading, error, imagesKey]);

  return state;
}
