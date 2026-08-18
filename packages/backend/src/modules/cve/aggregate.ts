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
  HistoryPoint,
  RawFinding,
  RawReport,
  ReducedReport,
} from './types';

const ACTIONABLE_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

/**
 * Reduce an image reference to its repository path.
 *
 * Tags bump on every release, so matching on the full ref would silently
 * empty the trend sparkline for any component that ever shipped. The repo
 * path is the only part stable across releases.
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

/**
 * The single definition of "actionable", shared with the Slack alert.
 * Changing it here without changing it there makes the two views disagree,
 * after which neither is believed.
 */
export function isActionable(f: RawFinding): boolean {
  const severity = String(f.severity ?? '').toUpperCase();
  return (
    ACTIONABLE_SEVERITIES.has(severity) && !!f.fixed && f.fixed.trim() !== ''
  );
}

/** Two running tags of one repo can report the same CVE twice. */
export function dedupeFindings(list: ActionableFinding[]): ActionableFinding[] {
  const seen = new Set<string>();
  const out: ActionableFinding[] = [];
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
 * Reduce a full report to actionable findings indexed by repo.
 *
 * This is where the 8MB becomes a few hundred KB: non-actionable findings are
 * discarded here and never retained. Showing all severities later is a change
 * to this function, not to fetching or caching.
 */
export function reduceReport(raw: RawReport): ReducedReport {
  const scannedRepos = new Set((raw.scanned ?? []).map(normalizeImageRef));
  const byRepo = new Map<string, ActionableFinding[]>();

  for (const f of raw.findings ?? []) {
    if (!isActionable(f)) continue;
    const repo = normalizeImageRef(f.image);
    const list = byRepo.get(repo);
    if (list) list.push(toActionable(f));
    else byRepo.set(repo, [toActionable(f)]);
    // A findings entry implies the image was scanned, even if `scanned` omits it.
    scannedRepos.add(repo);
  }

  for (const [repo, list] of byRepo) {
    byRepo.set(repo, dedupeFindings(list));
  }
  return { scannedRepos, byRepo };
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

/** Answer the per-component question: what is running, and what is wrong with it. */
export function summarizeForImages(
  reduced: ReducedReport,
  images: string[],
): ComponentReport {
  const matchedRefs: string[] = [];
  const unmatchedRefs: string[] = [];
  const collected: ActionableFinding[] = [];

  for (const ref of Array.from(new Set(images))) {
    const repo = normalizeImageRef(ref);
    if (reduced.scannedRepos.has(repo)) {
      matchedRefs.push(ref);
      collected.push(...(reduced.byRepo.get(repo) ?? []));
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
