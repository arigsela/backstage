/**
 * HTTP routes for the cve backend plugin.
 *
 *   POST /report   → mounted at /api/cve/report
 *   GET  /health   → mounted at /api/cve/health
 *
 * A thin shell over reportStore + aggregate: validate in, JSON out. Failures
 * return HTTP 200 with {ok:false, code, message} so the card renders them
 * inline rather than through a thrown fetch — same convention as
 * modules/kagent-suggest.
 */
import express, { Router } from 'express';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { normalizeImageRef, summarizeForImages } from './aggregate';
import type { ReportStore } from './reportStore';

export async function createRouter(opts: {
  store: ReportStore;
  logger: LoggerService;
}): Promise<Router> {
  const { store, logger } = opts;
  const router = Router();

  // Explicit JSON parser. Backstage's global parser does not reach
  // plugin-scoped routers in this codebase — req.body arrives undefined
  // without this (commit 0c97027). Applying our own is idempotent.
  router.use(express.json());

  router.post('/report', async (req, res) => {
    const images = req.body?.images;
    if (!Array.isArray(images) || images.some(i => typeof i !== 'string')) {
      res.status(200).json({
        ok: false,
        code: 'BAD_INPUT',
        message: 'images must be an array of strings',
      });
      return;
    }

    try {
      const { date, reduced } = await store.getLatest();
      const summary = summarizeForImages(reduced, images);
      const history = await store.getHistory();

      // Trend is scoped to the repos this component actually matched.
      const repos = summary.matchedRefs.map(normalizeImageRef);
      const trend = history.map(point => ({
        date: point.date,
        actionable: repos.reduce(
          (n, repo) => n + (point.countsByRepo.get(repo) ?? 0),
          0,
        ),
        // A week that never scanned these repos is a GAP, not a zero.
        // Rendering it as zero would read as "everything was fixed that week".
        covered: repos.some(repo => point.scannedRepos.has(repo)),
      }));

      res.status(200).json({ ok: true, scannedAt: date, ...summary, trend });
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`cve — REPORT_UNAVAILABLE: ${message}`);
      res.status(200).json({
        ok: false,
        code: 'REPORT_UNAVAILABLE',
        message,
      });
    }
  });

  router.get('/health', async (_req, res) => {
    try {
      res.status(200).json({ ok: true, ...(await store.health()) });
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`cve — BUCKET_UNREACHABLE: ${message}`);
      res.status(200).json({
        ok: false,
        code: 'BUCKET_UNREACHABLE',
        message,
      });
    }
  });

  return router;
}
