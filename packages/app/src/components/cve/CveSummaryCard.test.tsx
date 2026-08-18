import { render, screen } from '@testing-library/react';
import { CveSummaryCard } from './CveSummaryCard';

const mockUseCveReport = jest.fn();
jest.mock('./useCveReport', () => ({
  ...jest.requireActual('./useCveReport'),
  useCveReport: () => mockUseCveReport(),
}));
jest.mock('@backstage/core-components', () => ({
  InfoCard: ({ title, children }: any) => (
    <div>
      <h2>{title}</h2>
      {children}
    </div>
  ),
  Link: ({ children, to }: any) => <a href={to}>{children}</a>,
  Progress: () => <div>loading</div>,
}));

describe('CveSummaryCard', () => {
  it('renders a skeleton while loading', () => {
    mockUseCveReport.mockReturnValue({ kind: 'loading' });
    render(<CveSummaryCard />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('says it cannot determine images when nothing is running', () => {
    mockUseCveReport.mockReturnValue({ kind: 'no-workloads' });
    render(<CveSummaryCard />);
    expect(screen.getByText(/no running workloads/i)).toBeInTheDocument();
    expect(screen.queryByText(/no actionable vulnerabilities/i)).toBeNull();
  });

  it('distinguishes not-scanned from clean', () => {
    // The assertion this whole design exists to guarantee.
    mockUseCveReport.mockReturnValue({
      kind: 'not-scanned',
      refs: ['team/x:v1'],
    });
    const { unmount } = render(<CveSummaryCard />);
    expect(
      screen.getByText(/not covered by the weekly scan/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no actionable vulnerabilities/i)).toBeNull();
    expect(screen.getByText(/team\/x:v1/)).toBeInTheDocument();
    unmount();

    mockUseCveReport.mockReturnValue({
      kind: 'clean',
      scannedAt: '2026-08-17',
      matchedRefs: ['team/x:v1'],
    });
    render(<CveSummaryCard />);
    expect(
      screen.getByText(/no actionable vulnerabilities/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not covered/i)).toBeNull();
  });

  it('renders counts and a delta', () => {
    mockUseCveReport.mockReturnValue({
      kind: 'data',
      scannedAt: '2026-08-17',
      matchedRefs: ['team/app:v1'],
      unmatchedRefs: [],
      totals: { critical: 41, high: 155, actionable: 196 },
      findings: [],
      delta: -12,
      trend: [
        { date: '2026-08-10', actionable: 208, covered: true },
        { date: '2026-08-17', actionable: 196, covered: true },
      ],
    });
    render(<CveSummaryCard />);
    expect(screen.getByText('196')).toBeInTheDocument();
    expect(screen.getByText(/41/)).toBeInTheDocument();
    expect(screen.getByText(/155/)).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });

  it('explains that trend needs another scan when there is one point', () => {
    mockUseCveReport.mockReturnValue({
      kind: 'data',
      scannedAt: '2026-08-17',
      matchedRefs: ['team/app:v1'],
      unmatchedRefs: [],
      totals: { critical: 1, high: 0, actionable: 1 },
      findings: [],
      delta: undefined,
      trend: [{ date: '2026-08-17', actionable: 1, covered: true }],
    });
    render(<CveSummaryCard />);
    expect(screen.getByText(/after the next scan/i)).toBeInTheDocument();
  });

  it('renders an error as an error, not as zero', () => {
    mockUseCveReport.mockReturnValue({
      kind: 'error',
      message: 'AccessDenied',
    });
    render(<CveSummaryCard />);
    expect(screen.getByText(/AccessDenied/)).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });
});
