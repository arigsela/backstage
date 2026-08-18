import { render } from '@testing-library/react';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('renders nothing with fewer than two points', () => {
    const { container } = render(
      <Sparkline points={[{ value: 5, covered: true }]} />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a single path when every point is covered', () => {
    const { container } = render(
      <Sparkline
        points={[
          { value: 5, covered: true },
          { value: 3, covered: true },
          { value: 4, covered: true },
        ]}
      />,
    );
    expect(container.querySelectorAll('path')).toHaveLength(1);
  });

  it('breaks the line into segments around an uncovered week', () => {
    // A gap must not be drawn as a value — a zero would read as "all fixed".
    const { container } = render(
      <Sparkline
        points={[
          { value: 5, covered: true },
          { value: 6, covered: true },
          { value: 0, covered: false },
          { value: 4, covered: true },
          { value: 3, covered: true },
        ]}
      />,
    );
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });
});
