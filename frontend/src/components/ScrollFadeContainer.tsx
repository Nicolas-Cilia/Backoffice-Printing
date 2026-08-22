import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

const OVERFLOW_THRESHOLD_PX = 8;

interface ScrollFadeContainerProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Tailwind `from-*` class matching the pane background (default: page dark). */
  fadeFromClassName?: string;
}

/**
 * Scroll pane with a bottom fade while more content exists below.
 * Must be placed on the element that actually clips/scrolls — not a wrapper
 * whose parent is the real overflow container.
 */
export function ScrollFadeContainer({
  children,
  className = '',
  fadeFromClassName = 'from-bambu-dark',
  ...props
}: ScrollFadeContainerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      // Height 0 on first layout means the pane is not yet the clipping
      // scroller; skip so we don't latch overflow=false.
      if (el.clientHeight < 1) return;
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowFade(remaining > OVERFLOW_THRESHOLD_PX);
    };

    update();
    const raf = requestAnimationFrame(update);
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);

    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of el.children) {
      ro.observe(child);
    }

    const mo = new MutationObserver(() => {
      update();
      for (const child of el.children) {
        ro.observe(child);
      }
    });
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <div className="relative min-h-0 flex-1 flex flex-col h-full">
      <div
        ref={ref}
        data-testid="scroll-fade-scroller"
        className={`scroll-fade-pane min-h-0 flex-1 h-full overflow-y-scroll ${className}`}
        {...props}
      >
        {children}
      </div>
      <div
        data-testid="scroll-more-fade"
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t ${fadeFromClassName} to-transparent transition-opacity duration-200 ${
          showFade ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}
