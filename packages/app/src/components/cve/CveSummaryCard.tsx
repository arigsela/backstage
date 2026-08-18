/**
 * Overview-tab card summarising actionable container vulnerabilities for the
 * images this entity actually runs.
 *
 * Renders a state computed by useCveReport; it computes nothing itself.
 * Material UI v4 throughout.
 */
import { InfoCard, Link, Progress } from '@backstage/core-components';
import { Box, Typography, makeStyles } from '@material-ui/core';
import { Sparkline } from './Sparkline';
import { useCveReport } from './useCveReport';

const useStyles = makeStyles(theme => ({
  count: { fontSize: '2.5rem', lineHeight: 1, fontWeight: 500 },
  critical: { color: theme.palette.error.main },
  high: { color: theme.palette.warning.main },
  muted: { color: theme.palette.text.secondary },
  better: { color: theme.palette.success.main },
  worse: { color: theme.palette.error.main },
  refs: { wordBreak: 'break-all' },
}));

const TITLE = 'Vulnerabilities';

export const CveSummaryCard = () => {
  const classes = useStyles();
  const state = useCveReport();

  if (state.kind === 'loading') {
    return <InfoCard title={TITLE}><Progress /></InfoCard>;
  }

  if (state.kind === 'error') {
    return (
      <InfoCard title={TITLE}>
        <Typography variant="body2" className={classes.critical}>
          Could not load vulnerability data: {state.message}
        </Typography>
      </InfoCard>
    );
  }

  if (state.kind === 'no-workloads') {
    return (
      <InfoCard title={TITLE}>
        <Typography variant="body2" className={classes.muted}>
          No running workloads — can't determine which images this component uses.
        </Typography>
      </InfoCard>
    );
  }

  if (state.kind === 'not-scanned') {
    return (
      <InfoCard title={TITLE}>
        <Typography variant="body2" className={classes.muted}>
          Not covered by the weekly scan.
        </Typography>
        <Typography variant="caption" className={classes.refs} component="div">
          {state.refs.join(', ')}
        </Typography>
      </InfoCard>
    );
  }

  if (state.kind === 'clean') {
    return (
      <InfoCard title={TITLE}>
        <Typography variant="body2">No actionable vulnerabilities.</Typography>
        <Typography variant="caption" className={classes.muted}>
          Scanned {state.scannedAt}
        </Typography>
      </InfoCard>
    );
  }

  const { totals, delta, trend, scannedAt } = state;
  const points = trend.map(p => ({ value: p.actionable, covered: p.covered }));
  const hasTrend = trend.filter(p => p.covered).length >= 2;

  return (
    <InfoCard title={TITLE}>
      <Box display="flex" alignItems="center" justifyContent="space-between">
        <Box>
          <span className={classes.count}>{totals.actionable}</span>{' '}
          <Typography variant="body2" component="span" className={classes.muted}>
            actionable
          </Typography>
        </Box>
        {delta !== undefined && (
          <Typography
            variant="body2"
            className={delta <= 0 ? classes.better : classes.worse}
          >
            {delta <= 0 ? '↓' : '↑'} {Math.abs(delta)} vs last scan
          </Typography>
        )}
      </Box>

      <Box mt={1} mb={1}>
        {hasTrend ? (
          <Sparkline points={points} />
        ) : (
          <Typography variant="caption" className={classes.muted}>
            Trend available after the next scan.
          </Typography>
        )}
      </Box>

      <Typography variant="body2">
        <span className={classes.critical}>CRITICAL {totals.critical}</span>
        {'   '}
        <span className={classes.high}>HIGH {totals.high}</span>
      </Typography>

      <Box mt={1} display="flex" justifyContent="space-between" alignItems="center">
        <Typography variant="caption" className={classes.muted}>
          Scanned {scannedAt}
        </Typography>
        <Link to="security">View all →</Link>
      </Box>
    </InfoCard>
  );
};
