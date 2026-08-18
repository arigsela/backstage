import { render, screen } from '@testing-library/react';
import { CveFindingsTable } from './CveFindingsTable';

const mockUseCveReport = jest.fn();
// Narrow mock only — spreading jest.requireActual('./useCveReport') pulls in
// the real module, which transitively imports an xterm terminal component
// that probes HTMLCanvasElement.getContext at import time. jsdom does not
// implement that API, so the test output fills with noise. See Task 5.
jest.mock('./useCveReport', () => ({
  useCveReport: () => mockUseCveReport(),
}));
jest.mock('@backstage/core-components', () => ({
  Table: ({ title, data, columns }: any) => (
    <div>
      <h2>{title}</h2>
      <table>
        <tbody>
          {data.map((row: any, i: number) => (
            <tr key={i}>
              {columns.map((c: any, j: number) => (
                <td key={j}>{c.render ? c.render(row) : row[c.field]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  Link: ({ children, to }: any) => <a href={to}>{children}</a>,
  Progress: () => <div>loading</div>,
  EmptyState: ({ title, description }: any) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  ),
}));

const finding = {
  id: 'CVE-2026-1234',
  pkg: 'openssl',
  installed: '3.0.11',
  fixed: '3.0.14',
  severity: 'CRITICAL',
  title: 'openssl: bad thing',
  image: 'team/app:v1',
};

describe('CveFindingsTable', () => {
  it('renders a row per finding with a link to the CVE', () => {
    mockUseCveReport.mockReturnValue({
      kind: 'data',
      scannedAt: '2026-08-17',
      matchedRefs: ['team/app:v1'],
      unmatchedRefs: [],
      totals: { critical: 1, high: 0, actionable: 1 },
      findings: [finding],
      trend: [],
      delta: undefined,
    });
    render(<CveFindingsTable />);
    expect(screen.getByText('CVE-2026-1234')).toBeInTheDocument();
    expect(screen.getByText('openssl')).toBeInTheDocument();
    expect(screen.getByText('3.0.14')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /CVE-2026-1234/ })).toHaveAttribute(
      'href',
      'https://nvd.nist.gov/vuln/detail/CVE-2026-1234',
    );
  });

  it('flags images the scan missed even when other images produced findings', () => {
    // Regression guard for a mixed-coverage report: some images matched and
    // produced findings, but at least one did not. Silently dropping this
    // caption would make a partial scan look complete — the same failure
    // family `not-scanned` vs `clean` exists to prevent, just inside the
    // `data` state instead of at the top level.
    mockUseCveReport.mockReturnValue({
      kind: 'data',
      scannedAt: '2026-08-17',
      matchedRefs: ['team/app:v1'],
      unmatchedRefs: ['team/other:v2'],
      totals: { critical: 1, high: 0, actionable: 1 },
      findings: [finding],
      trend: [],
      delta: undefined,
    });
    render(<CveFindingsTable />);
    expect(screen.getByText('CVE-2026-1234')).toBeInTheDocument();
    expect(screen.getByText(/not covered by the scan/i)).toBeInTheDocument();
    expect(screen.getByText(/team\/other:v2/)).toBeInTheDocument();
  });

  it('shows a reassuring empty state only when genuinely clean', () => {
    mockUseCveReport.mockReturnValue({
      kind: 'clean',
      scannedAt: '2026-08-17',
      matchedRefs: ['team/app:v1'],
    });
    render(<CveFindingsTable />);
    expect(
      screen.getByText(/no actionable vulnerabilities/i),
    ).toBeInTheDocument();
  });

  it('shows a non-reassuring empty state when not scanned', () => {
    mockUseCveReport.mockReturnValue({
      kind: 'not-scanned',
      refs: ['team/x:v1'],
    });
    render(<CveFindingsTable />);
    expect(
      screen.getByText(/not covered by the weekly scan/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no actionable vulnerabilities/i)).toBeNull();
  });

  it('renders an error state', () => {
    mockUseCveReport.mockReturnValue({
      kind: 'error',
      message: 'AccessDenied',
    });
    render(<CveFindingsTable />);
    expect(screen.getByText(/AccessDenied/)).toBeInTheDocument();
    // An error must never render as a zero — same property CveSummaryCard
    // asserts for the identical state, kept in lockstep here.
    expect(screen.queryByText('0')).toBeNull();
  });
});
