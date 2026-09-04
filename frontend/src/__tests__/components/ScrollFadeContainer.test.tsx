import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../utils';
import { ScrollFadeContainer } from '../../components/ScrollFadeContainer';

function mockScrollerOverflow(
  el: HTMLElement,
  { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop });
}

describe('ScrollFadeContainer', () => {
  it('shows a bottom fade while more content exists below, then hides it at the bottom', () => {
    render(
      <ScrollFadeContainer>
        <div>section one</div>
        <div>section two</div>
      </ScrollFadeContainer>,
    );

    const scroller = screen.getByTestId('scroll-fade-scroller');
    const fade = screen.getByTestId('scroll-more-fade');
    expect(scroller).toHaveClass('overflow-y-scroll');
    expect(scroller).toHaveClass('scroll-fade-pane');
    expect(fade).toHaveClass('opacity-0');

    mockScrollerOverflow(scroller, { scrollHeight: 800, clientHeight: 400, scrollTop: 0 });
    fireEvent(window, new Event('resize'));
    expect(fade).toHaveClass('opacity-100');

    mockScrollerOverflow(scroller, { scrollHeight: 800, clientHeight: 400, scrollTop: 400 });
    fireEvent.scroll(scroller);
    expect(fade).toHaveClass('opacity-0');
  });

  it('does not treat a zero-height mount as "no overflow"', () => {
    render(
      <ScrollFadeContainer>
        <div>tall content</div>
      </ScrollFadeContainer>,
    );

    const scroller = screen.getByTestId('scroll-fade-scroller');
    const fade = screen.getByTestId('scroll-more-fade');

    mockScrollerOverflow(scroller, { scrollHeight: 800, clientHeight: 0, scrollTop: 0 });
    fireEvent(window, new Event('resize'));
    expect(fade).toHaveClass('opacity-0');

    mockScrollerOverflow(scroller, { scrollHeight: 800, clientHeight: 400, scrollTop: 0 });
    fireEvent(window, new Event('resize'));
    expect(fade).toHaveClass('opacity-100');
  });

  it('notifies onHasMoreChange when overflow below changes', () => {
    const onHasMoreChange = vi.fn();
    render(
      <ScrollFadeContainer onHasMoreChange={onHasMoreChange}>
        <div>section one</div>
        <div>section two</div>
      </ScrollFadeContainer>,
    );

    const scroller = screen.getByTestId('scroll-fade-scroller');
    onHasMoreChange.mockClear();

    mockScrollerOverflow(scroller, { scrollHeight: 800, clientHeight: 400, scrollTop: 0 });
    fireEvent(window, new Event('resize'));
    expect(onHasMoreChange).toHaveBeenLastCalledWith(true);

    mockScrollerOverflow(scroller, { scrollHeight: 800, clientHeight: 400, scrollTop: 400 });
    fireEvent.scroll(scroller);
    expect(onHasMoreChange).toHaveBeenLastCalledWith(false);
  });
});