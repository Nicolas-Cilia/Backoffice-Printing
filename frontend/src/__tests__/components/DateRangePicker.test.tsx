import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateRangePicker } from '../../components/DateRangePicker';
import type { CalendarDateRange } from '../../utils/dateRange';

function Harness({ initial }: { initial?: CalendarDateRange }) {
  const [value, setValue] = useState<CalendarDateRange>(initial ?? { from: null, to: null });
  return (
    <>
      <DateRangePicker label="Date range" value={value} onChange={setValue} />
      <pre data-testid="range">{JSON.stringify(value)}</pre>
    </>
  );
}

describe('DateRangePicker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeAugust2026() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0));
  }

  it('lets the user pick a start and end day on the calendar', async () => {
    freezeAugust2026();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    expect(screen.getByRole('dialog', { name: 'Choose a date range' })).toBeInTheDocument();
    expect(screen.getByText('August 2026')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '20' }));
    await user.click(screen.getByRole('button', { name: '24' }));

    expect(screen.getByTestId('range')).toHaveTextContent(
      JSON.stringify({ from: '2026-08-20', to: '2026-08-24' }),
    );
    expect(screen.queryByRole('dialog', { name: 'Choose a date range' })).not.toBeInTheDocument();
  });

  it('treats two clicks on the same day as a single-day range', async () => {
    freezeAugust2026();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    await user.click(screen.getByRole('button', { name: '24' }));
    await user.click(screen.getByRole('button', { name: '24' }));

    expect(screen.getByTestId('range')).toHaveTextContent(
      JSON.stringify({ from: '2026-08-24', to: '2026-08-24' }),
    );
  });

  it('orders a range picked backwards', async () => {
    freezeAugust2026();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    await user.click(screen.getByRole('button', { name: '24' }));
    await user.click(screen.getByRole('button', { name: '20' }));

    expect(screen.getByTestId('range')).toHaveTextContent(
      JSON.stringify({ from: '2026-08-20', to: '2026-08-24' }),
    );
  });

  it('clears the selected range', async () => {
    freezeAugust2026();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness initial={{ from: '2026-08-20', to: '2026-08-24' }} />);

    await user.click(screen.getByRole('button', { name: 'Date range' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByTestId('range')).toHaveTextContent(
      JSON.stringify({ from: null, to: null }),
    );
  });
});
