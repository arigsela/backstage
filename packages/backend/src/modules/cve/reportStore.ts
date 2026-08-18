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

/** Matches `cve-reports/2026-08-17.json` and captures the date. */
const DATED_KEY = /(\d{4}-\d{2}-\d{2})\.json$/;

export class ReportStore {
  private latest?: { fetchedAt: number; date: string; reduced: ReducedReport };
  private readonly history = new Map<string, HistoryPoint>();

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

  /** All available report dates, newest first. */
  private async listDates(): Promise<string[]> {
    const keys = await this.source.listKeys(this.cfg.prefix);
    return keys
      .map(k => DATED_KEY.exec(k)?.[1])
      .filter((d): d is string => Boolean(d))
      .sort()
      .reverse();
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
    const keys = await this.source.listKeys(this.cfg.prefix);
    return { keysFound: keys.length, dates: await this.listDates() };
  }
}
