import { describe, it, expect } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../utils';
import { HorizontalScrollFade } from '../../components/HorizontalScrollFade';

function mockScrollerOverflow(
  el: HTMLElement,
  { scrollWidth, clientWidth, scrollLeft }: { scrollWidth: number; clientWidth: number; scrollLeft: number },
) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, value: scrollLeft });
}

describe('HorizontalScrollFade', () => {
  it('fades the right edge at the start, both edges in the middle, and the left edge at the end', () => {
    render(
      <HorizontalScrollFade>
        <div>Registered Parts</div>
        <div>All parts</div>
      </HorizontalScrollFade>,
    );

    const scroller = screen.getByTestId('horizontal-scroll-fade-scroller');
    const left = screen.getByTestId('horizontal-scroll-fade-left');
    const right = screen.getByTestId('horizontal-scroll-fade-right');
    expect(left).toHaveClass('opacity-0');
    expect(right).toHaveClass('opacity-0');

    mockScrollerOverflow(scroller, { scrollWidth: 800, clientWidth: 400, scrollLeft: 0 });
    fireEvent(window, new Event('resize'));
    expect(left).toHaveClass('opacity-0');
    expect(right).toHaveClass('opacity-100');

    mockScrollerOverflow(scroller, { scrollWidth: 800, clientWidth: 400, scrollLeft: 200 });
    fireEvent.scroll(scroller);
    expect(left).toHaveClass('opacity-100');
    expect(right).toHaveClass('opacity-100');

    mockScrollerOverflow(scroller, { scrollWidth: 800, clientWidth: 400, scrollLeft: 400 });
    fireEvent.scroll(scroller);
    expect(left).toHaveClass('opacity-100');
    expect(right).toHaveClass('opacity-0');
  });
});
