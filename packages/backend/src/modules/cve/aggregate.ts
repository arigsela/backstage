/**
 * Pure aggregation logic for the cve backend plugin.
 *
 * No I/O, no framework, no clock. Everything here is a total function over
 * plain data, because this is the file where the feature can be quietly wrong:
 * the two rules below decide every number the UI shows.
 */
import type {
  ActionableFinding,
  ComponentReport,
  CountedFinding,
  HistoryPoint,
  ImageFindings,
  RawFinding,
  RawReport,
  ReducedReport,
} from './types';

const ACTIONABLE_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

/**
 * Reduce an image reference to its repository path.
 *
 * For the trend only. Tags bump on every release, so the sparkline needs the
 * one part stable across releases. Current findings match the exact ref or
 * digest instead (see scannedRefFor).
 */
export function normalizeImageRef(ref: string): string {
  // Digest first — a digest can follow a tag ("app:v1@sha256:...").
  const atIdx = ref.indexOf('@');
  let out = atIdx === -1 ? ref : ref.slice(0, atIdx);

  // A ':' is a tag separator ONLY after the last '/'. Otherwise it is a
  // registry port, and stripping it collapses a whole registry into one repo.
  const lastColon = out.lastIndexOf(':');
  const lastSlash = out.lastIndexOf('/');
  if (lastColon > lastSlash) {
    out = out.slice(0, lastColon);
  }
  return out;
}

/** The `sha256:…` digest of a ref, or undefined for a tag-only ref. */
export function imageDigest(ref: string): string | undefined {
  const atIdx = ref.indexOf('@');
  if (atIdx === -1) return undefined;
  const digest = ref.slice(atIdx + 1);
  return digest.startsWith('sha256:') ? digest : undefined;
}

/**
 * The definition of "actionable" used by this feature.
 *
 * The canonical definition lives in the Slack alerting scanner
 * (arigsela/kubernetes, base-apps/argo-workflow-tasks/configmap-cve-report.yaml,
 * `actionable()`) and has THREE clauses: the image is under our owned ECR
 * prefix ("852893458518.dkr.ecr."), severity is CRITICAL or HIGH, and a fix
 * exists.
 *
 * We deliberately use only the latter two and drop the ownership clause. That
 * clause exists in the Slack alert to stop paging on images we cannot rebuild
 * ourselves — but applying it here would render every component running an
 * upstream (non-ECR) image as falsely "clean" on its catalog page, even while
 * a real, fixable CRITICAL sits inside that image. Ownership is an alerting
 * concern, not a "does this component have a problem" concern. See spec §5
 * (amended in commit b27f4f8) for the full rationale. This divergence from
 * the Slack alert is intentional — do not "fix" it to add the ownership
 * filter.
 */
export function isActionable(f: RawFinding): boolean {
  const severity = String(f.severity ?? '').toUpperCase();
  return (
    ACTIONABLE_SEVERITIES.has(severity) && !!f.fixed && f.fixed.trim() !== ''
  );
}

/** Critical with no fixed version upstream: shown for awareness only. */
export function isCriticalNoFix(f: RawFinding): boolean {
  return (
    String(f.severity ?? '').toUpperCase() === 'CRITICAL' &&
    !(f.fixed && f.fixed.trim() !== '')
  );
}

/** Actively exploited (CISA KEV) and fixable, at any severity. */
export function isKevFixable(f: RawFinding): boolean {
  return f.kev === true && !!f.fixed && f.fixed.trim() !== '';
}

/** Two running tags of one repo can report the same CVE twice. */
export function dedupeFindings<T extends CountedFinding>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of list) {
    const key = `${f.id}|${f.pkg}|${f.installed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function toActionable(f: RawFinding): ActionableFinding {
  return {
    id: f.id,
    pkg: f.pkg,
    installed: f.installed,
    fixed: f.fixed!,
    severity: String(f.severity).toUpperCase() as 'CRITICAL' | 'HIGH',
    title: f.title,
    image: f.image,
  };
}

/**
 * Reduce a full report to what the card, the table and the scorecard show:
 * actionable findings by repo (trend) and by exact image ref, plus each
 * image's critical-no-fix and KEV-fixable findings as counted keys.
 *
 * This is where the ~10MB becomes a few hundred KB: everything else (medium,
 * low, unfixable high) is discarded here and never retained.
 */
export function reduceReport(raw: RawReport): ReducedReport {
  // Defense in depth: a caller that reaches this function without going
  // through assertRawReport first must not have a truncated report silently
  // coalesce into "0 scanned, 0 findings" via `?? []` — that reads as a clean
  // sweep, the most dangerous failure mode for this feature. This call is
  // cheap (two Array.isArray checks) and idempotent when the caller already
  // validated.
  assertRawReport(raw);
  const scannedRepos = new Set(raw.scanned.map(normalizeImageRef));
  const byRepo = new Map<string, ActionableFinding[]>();
  const images = new Map<string, ImageFindings>();
  const imageEntry = (ref: string): ImageFindings => {
    let entry = images.get(ref);
    if (!entry) {
      entry = { actionable: [], criticalNoFix: [], kevFixable: [] };
      images.set(ref, entry);
    }
    return entry;
  };
  for (const ref of raw.scanned) imageEntry(ref);

  for (const f of raw.findings) {
    // A findings entry implies the image was scanned, even if `scanned` omits it.
    const entry = imageEntry(f.image);
    const counted = { id: f.id, pkg: f.pkg, installed: f.installed };
    if (isCriticalNoFix(f)) entry.criticalNoFix.push(counted);
    if (isKevFixable(f)) entry.kevFixable.push(counted);
    if (!isActionable(f)) continue;
    const repo = normalizeImageRef(f.image);
    const list = byRepo.get(repo);
    if (list) list.push(toActionable(f));
    else byRepo.set(repo, [toActionable(f)]);
    entry.actionable.push(toActionable(f));
    scannedRepos.add(repo);
  }

  for (const [repo, list] of byRepo) {
    byRepo.set(repo, dedupeFindings(list));
  }
  const refByDigest = new Map<string, string>();
  for (const [ref, entry] of images) {
    entry.actionable = dedupeFindings(entry.actionable);
    entry.criticalNoFix = dedupeFindings(entry.criticalNoFix);
    entry.kevFixable = dedupeFindings(entry.kevFixable);
    const digest = imageDigest(ref);
    if (digest) refByDigest.set(digest, ref);
  }
  const kevChecked = raw.findings.every(f => typeof f.kev === 'boolean');
  return { scannedRepos, byRepo, images, refByDigest, kevChecked };
}

/**
 * Reduce a dated report to what trend needs.
 *
 * Derived from reduceReport rather than counted independently, so trend and
 * current counts can never drift apart arithmetically.
 */
export function historyPointFromRaw(
  date: string,
  raw: RawReport,
): HistoryPoint {
  const reduced = reduceReport(raw);
  const countsByRepo = new Map<string, number>();
  for (const [repo, list] of reduced.byRepo) {
    countsByRepo.set(repo, list.length);
  }
  return { date, scannedRepos: reduced.scannedRepos, countsByRepo };
}

/**
 * The scanned ref a running ref stands for: the same ref, or the same digest
 * written differently (`repo@sha256:x` vs `repo:v1@sha256:x`). Never another
 * tag of the same repo: that reported last week's image (hk-demo v0.5.0's
 * CVEs against the v0.7.0 it was running) as the current one.
 */
function scannedRefFor(
  reduced: ReducedReport,
  ref: string,
): string | undefined {
  if (reduced.images.has(ref)) return ref;
  const digest = imageDigest(ref);
  return digest ? reduced.refByDigest.get(digest) : undefined;
}

/** Answer the per-component question: what is running, and what is wrong with it. */
export function summarizeForImages(
  reduced: ReducedReport,
  images: string[],
): ComponentReport {
  const matchedRefs: string[] = [];
  const unmatchedRefs: string[] = [];
  const collected: ActionableFinding[] = [];
  const noFix: CountedFinding[] = [];
  const kev: CountedFinding[] = [];

  for (const ref of Array.from(new Set(images))) {
    const scanned = scannedRefFor(reduced, ref);
    const entry =
      scanned === undefined ? undefined : reduced.images.get(scanned);
    if (entry) {
      matchedRefs.push(ref);
      collected.push(...entry.actionable);
      noFix.push(...entry.criticalNoFix);
      kev.push(...entry.kevFixable);
    } else {
      unmatchedRefs.push(ref);
    }
  }

  const findings = dedupeFindings(collected);
  return {
    matchedRefs,
    unmatchedRefs,
    totals: {
      critical: findings.filter(f => f.severity === 'CRITICAL').length,
      high: findings.filter(f => f.severity === 'HIGH').length,
      actionable: findings.length,
      criticalNoFix: dedupeFindings(noFix).length,
      kevFixable: dedupeFindings(kev).length,
    },
    findings,
  };
}

/**
 * Validate a parsed report before trusting it.
 *
 * A truncated report must raise, not silently reduce to zero findings —
 * a partial parse rendering as "0 actionable" is the most dangerous possible
 * failure mode for this feature.
 */
export function assertRawReport(v: unknown): asserts v is RawReport {
  if (!v || typeof v !== 'object') {
    throw new Error('report is not an object');
  }
  const r = v as Partial<RawReport>;
  if (!Array.isArray(r.scanned)) {
    throw new Error('report.scanned is missing or not an array');
  }
  if (!Array.isArray(r.findings)) {
    throw new Error('report.findings is missing or not an array');
  }
}
