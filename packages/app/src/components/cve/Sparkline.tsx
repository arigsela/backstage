/**
 * A minimal inline-SVG sparkline. Hand-rolled rather than pulling a charting
 * library in for eight points on a Material UI v4 tree.
 *
 * Uncovered weeks break the line into separate path segments instead of being
 * plotted. Plotting a gap as zero would read as "everything was fixed that
 * week", which is the most flattering possible misreading of missing data.
 */
import { makeStyles } from '@material-ui/core/styles';

export interface SparkPoint {
  value: number;
  covered: boolean;
}

const useStyles = makeStyles(theme => ({
  line: {
    fill: 'none',
    stroke: theme.palette.text.secondary,
    strokeWidth: 1.5,
    strokeLinejoin: 'round',
    strokeLinecap: 'round',
  },
}));

export const Sparkline = ({
  points,
  width = 120,
  height = 28,
}: {
  points: SparkPoint[];
  width?: number;
  height?: number;
}) => {
  const classes = useStyles();

  const covered = points.filter(p => p.covered);
  if (covered.length < 2) return null;

  const max = Math.max(...covered.map(p => p.value), 1);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const pad = 2;
  const yOf = (v: number) => height - pad - (v / max) * (height - pad * 2);

  // Split into runs of consecutive covered points; each run is one path.
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (!p.covered) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(
      `${current.length === 0 ? 'M' : 'L'}${i * step},${yOf(p.value)}`,
    );
  });
  if (current.length > 1) segments.push(current.join(' '));

  // Defence in depth: `covered.length >= 2` above only guarantees enough
  // covered points *somewhere*, not that any two are adjacent. Scattered
  // covered points (each isolated by a gap) pass that check yet produce zero
  // drawable segments — without this, the result would be an empty <svg>,
  // which reads as "no data" without explaining why. Returning null lets the
  // caller show a real fallback instead.
  if (segments.length === 0) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      {segments.map((d, i) => (
        <path key={i} d={d} className={classes.line} />
      ))}
    </svg>
  );
};
