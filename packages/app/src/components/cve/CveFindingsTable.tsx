/**
 * Security-tab content: every actionable finding for the images this entity
 * runs, sortable and searchable.
 *
 * Reads the same hook as the Overview card, so the tab and the card can never
 * disagree. The empty states are deliberately different for `clean` and
 * `not-scanned` — see useCveReport.
 */
import { EmptyState, Link, Progress, Table } from '@backstage/core-components';
import type { TableColumn } from '@backstage/core-components';
import { Typography } from '@material-ui/core';
import { Finding, useCveReport } from './useCveReport';

const columns: TableColumn<Finding>[] = [
  {
    title: 'CVE',
    field: 'id',
    render: (row: Finding) => (
      <Link to={`https://nvd.nist.gov/vuln/detail/${row.id}`}>{row.id}</Link>
    ),
  },
  { title: 'Severity', field: 'severity', width: '110px' },
  { title: 'Package', field: 'pkg' },
  { title: 'Installed', field: 'installed' },
  { title: 'Fixed in', field: 'fixed' },
  { title: 'Title', field: 'title' },
  { title: 'Image', field: 'image' },
];

export const CveFindingsTable = () => {
  const state = useCveReport();

  if (state.kind === 'loading') return <Progress />;

  if (state.kind === 'error') {
    return (
      <EmptyState
        missing="data"
        title="Could not load vulnerability data"
        description={state.message}
      />
    );
  }

  if (state.kind === 'no-workloads') {
    return (
      <EmptyState
        missing="data"
        title="No running workloads"
        description="Can't determine which images this component uses, so no scan results can be matched to it."
      />
    );
  }

  if (state.kind === 'not-scanned') {
    return (
      <EmptyState
        missing="data"
        title="Not covered by the weekly scan"
        description={`These images were not in the most recent scan: ${state.refs.join(
          ', ',
        )}`}
      />
    );
  }

  if (state.kind === 'clean') {
    return (
      <EmptyState
        missing="content"
        title="No actionable vulnerabilities"
        description={`Scanned ${state.scannedAt}. Actionable means CRITICAL or HIGH with a published fix.`}
      />
    );
  }

  return (
    <>
      <Table<Finding>
        title={`${state.totals.actionable} actionable findings — scanned ${state.scannedAt}`}
        columns={columns}
        data={state.findings}
        options={{ search: true, paging: true, pageSize: 20, sorting: true }}
      />
      {state.unmatchedRefs.length > 0 && (
        <Typography variant="caption" color="textSecondary">
          Not covered by the scan: {state.unmatchedRefs.join(', ')}
        </Typography>
      )}
    </>
  );
};
