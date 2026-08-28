import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

const OVERFLOW_THRESHOLD_PX = 8;

interface HorizontalScrollFadeProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Tailwind `from-*` class matching the pane background (default: page dark). */
  fadeFromClassName?: string;
}

/**
 * Horizontal scroller with edge fades while more chips exist past that side.
 * Left fade appears after you leave the start; right fade until you hit the end.
 */
export function HorizontalScrollFade({
  children,
  className = '',
  fadeFromClassName = 'from-bambu-dark',
  ...props
}: HorizontalScrollFadeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      if (el.clientWidth < 1) return;
      setShowLeft(el.scrollLeft > OVERFLOW_THRESHOLD_PX);
      const remaining = el.scrollWidth - el.scrollLeft - el.clientWidth;
      setShowRight(remaining > OVERFLOW_THRESHOLD_PX);
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
    <div className={`relative min-w-0 ${className}`}>
      <div
        ref={ref}
        data-testid="horizontal-scroll-fade-scroller"
        className="overflow-x-auto scroll-touch touch-pan-x"
        {...props}
      >
        {children}
      </div>
      <div
        data-testid="horizontal-scroll-fade-left"
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r ${fadeFromClassName} to-transparent transition-opacity duration-200 md:hidden ${
          showLeft ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        data-testid="horizontal-scroll-fade-right"
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l ${fadeFromClassName} to-transparent transition-opacity duration-200 md:hidden ${
          showRight ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}
