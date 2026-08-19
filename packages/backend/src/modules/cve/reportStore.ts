/**
 * Fetch, reduce, and cache CVE reports.
 *
 * Caching has two tiers because the data has two lifetimes:
 *   - latest.json is mutable (rewritten weekly) and carries a TTL.
 *   - Dated reports are immutable once written and are cached forever.
 *
 * Only reduced data is retained. The raw 8MB report is parsed, reduced, and
 * dropped within a single call.
 */
import {
  assertRawReport,
  historyPointFromRaw,
  reduceReport,
} from './aggregate';
import type { CveConfig } from './config';
import type { ReportSource } from './s3Client';
import type { HistoryPoint, RawReport, ReducedReport } from './types';

/**
 * Matches `cve-reports/2026-08-17.json` and captures the date.
 *
 * Anchored to the start of the basename (`^` or after the last `/`), not just
 * the `.json` suffix. This bucket is a general Argo artifacts bucket written
 * by another repo, not ours alone — an unrelated object like
 * `cve-reports/backup-2026-09-01.json` still ends in `\d{4}-\d{2}-\d{2}\.json`
 * and, unanchored, would extract a date whose corresponding
 * `${prefix}${date}.json` key does not exist. getHistory() would then throw
 * fetching it, and the router turns any store throw into REPORT_UNAVAILABLE
 * for every component — one stray object in someone else's write path taking
 * the whole card down permanently.
 */
const DATED_KEY = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.json$/;

/** Extract report dates from a key listing, newest first. Pure. */
function datesFromKeys(keys: string[]): string[] {
  return keys
    .map(k => DATED_KEY.exec(k)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort()
    .reverse();
}

export class ReportStore {
  private latest?: { fetchedAt: number; date: string; reduced: ReducedReport };
  private readonly history = new Map<string, HistoryPoint>();
  /** Undefined until the first listing; drives the same TTL as `latest`. */
  private datesFetchedAt?: number;
  private datesCache: string[] = [];

  constructor(
    private readonly source: ReportSource,
    private readonly cfg: CveConfig,
    /** Injectable clock — the tests drive the TTL through it. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async fetchReport(key: string): Promise<RawReport> {
    const parsed = await this.source.getJson(key);
    assertRawReport(parsed);
    return parsed;
  }

  /**
   * All available report dates, newest first — TTL-cached alongside `latest`.
   *
   * The caching is the point, not an optimisation. `getLatest` is TTL-cached,
   * so without this `getHistory` would re-list S3 on every request and pick up
   * a brand-new dated report while the headline count was still serving the
   * previous run from cache. The card would then show, say, "195 actionable"
   * next to a delta of "down 63 vs last scan" — two numbers from two different
   * scans, disagreeing on screen for up to an hour. Sharing one TTL means both
   * halves of the card always describe the same run.
   *
   * `health()` deliberately does NOT go through here — see its comment.
   */
  private async listDates(): Promise<string[]> {
    if (
      this.datesFetchedAt !== undefined &&
      this.now() - this.datesFetchedAt < this.cfg.cacheTtlMs
    ) {
      return this.datesCache;
    }
    const keys = await this.source.listKeys(this.cfg.prefix);
    this.datesCache = datesFromKeys(keys);
    this.datesFetchedAt = this.now();
    return this.datesCache;
  }

  async getLatest(): Promise<{ date: string; reduced: ReducedReport }> {
    const cached = this.latest;
    if (cached && this.now() - cached.fetchedAt < this.cfg.cacheTtlMs) {
      return { date: cached.date, reduced: cached.reduced };
    }
    const raw = await this.fetchReport(`${this.cfg.prefix}latest.json`);
    // latest.json carries no date of its own; the newest dated key names it.
    const [newest] = await this.listDates();
    this.latest = {
      fetchedAt: this.now(),
      date: newest ?? 'unknown',
      reduced: reduceReport(raw),
    };
    return { date: this.latest.date, reduced: this.latest.reduced };
  }

  /** Oldest-first, so the sparkline reads left to right. */
  async getHistory(): Promise<HistoryPoint[]> {
    const dates = (await this.listDates()).slice(0, this.cfg.historyWeeks);
    const points: HistoryPoint[] = [];
    for (const date of dates) {
      let point = this.history.get(date);
      if (!point) {
        const raw = await this.fetchReport(`${this.cfg.prefix}${date}.json`);
        point = historyPointFromRaw(date, raw);
        this.history.set(date, point); // immutable — never expires
      }
      points.push(point);
    }
    return points.reverse();
  }

  /** Diagnostic for "have the stable keys landed yet?" — see router GET /health. */
  async health(): Promise<{ keysFound: number; dates: string[] }> {
    // Deliberately bypasses the TTL cache above. This route exists to answer
    // "have the report keys landed yet?", so serving an hour-old listing would
    // defeat its only purpose. Deriving the dates from the same listing also
    // means one ListObjectsV2 call here, not two.
    const keys = await this.source.listKeys(this.cfg.prefix);
    return { keysFound: keys.length, dates: datesFromKeys(keys) };
  }
}
