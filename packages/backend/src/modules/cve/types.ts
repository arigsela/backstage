/**
 * Shared types for the cve backend plugin.
 *
 * RawReport mirrors the on-disk schema of cve-reports/*.json exactly.
 * Everything else is our reduced, actionable-only view of it.
 */

/** One Trivy finding, exactly as it appears in the report. */
export interface RawFinding {
  image: string;
  id: string;
  pkg: string;
  installed: string;
  /** Absent or "" when no patch exists upstream. */
  fixed?: string;
  severity: string;
  title: string;
  /** On CISA's Known Exploited Vulnerabilities list (the scan's KEV enrichment). */
  kev?: boolean | null;
  /** EPSS exploit-probability score; null when the feed had none. */
  epss?: number | null;
}

/** Enough of a finding to count it once across a component's images. */
export interface CountedFinding {
  id: string;
  pkg: string;
  installed: string;
}

/** What one scanned image carries, keyed by its exact ref. */
export interface ImageFindings {
  actionable: ActionableFinding[];
  /** CRITICAL with no fixed version upstream yet. */
  criticalNoFix: CountedFinding[];
  /** On the KEV list with a fix, at any severity. */
  kevFixable: CountedFinding[];
}

/** The on-disk report schema. */
export interface RawReport {
  scanned: string[];
  failed: string[];
  findings: RawFinding[];
}

/** A finding that passed isActionable(). `fixed` is guaranteed non-empty. */
export interface ActionableFinding {
  id: string;
  pkg: string;
  installed: string;
  fixed: string;
  severity: 'CRITICAL' | 'HIGH';
  title: string;
  /** The original full image ref, kept for display so the join stays visible. */
  image: string;
}

/**
 * latest.json reduced to actionable findings only, indexed by repository path.
 *
 * scannedRepos is the crucial second field: a repo present here with no entry
 * in byRepo was scanned and is clean. A repo absent from here was never
 * scanned. Those two must never be conflated.
 */
export interface ReducedReport {
  /** Repo-level coverage and findings: the trend only, which spans releases. */
  scannedRepos: Set<string>;
  byRepo: Map<string, ActionableFinding[]>;
  /**
   * Exact scanned ref → its findings. Current answers match on this (or on
   * refByDigest), never on the repo: a newer tag of a scanned repo is not
   * scanned until the next weekly run.
   */
  images: Map<string, ImageFindings>;
  /** `sha256:…` digest → the scanned ref that carried it. */
  refByDigest: Map<string, string>;
}

/** One dated report reduced to what trend needs: coverage plus counts. */
export interface HistoryPoint {
  date: string;
  scannedRepos: Set<string>;
  countsByRepo: Map<string, number>;
}

/** The per-component answer the router returns. */
export interface ComponentReport {
  matchedRefs: string[];
  unmatchedRefs: string[];
  totals: {
    critical: number;
    high: number;
    actionable: number;
    /** CRITICAL with no fix yet (awareness; not in `findings`). */
    criticalNoFix: number;
    /** On the KEV list with a fix, at any severity. */
    kevFixable: number;
  };
  findings: ActionableFinding[];
}
