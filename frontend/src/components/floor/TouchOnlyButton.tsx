import type { ButtonHTMLAttributes, PointerEvent, ReactNode } from 'react';

type TouchOnlyButtonProps = {
  onActivate: () => void;
  children: ReactNode;
  className?: string;
  'aria-label': string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onKeyDown' | 'type' | 'tabIndex'>;

function isPointerActivation(event: Pick<PointerEvent<HTMLElement>, 'button'>): boolean {
  // Keyboard never dispatches pointer events. Right-click / other mouse
  // buttons are ignored; a missing button (jsdom) still counts as primary.
  return event.button == null || event.button === 0;
}

/**
 * Floor scan control that a USB/HID pistol cannot "press".
 *
 * The pistol types characters and Enter into whatever has focus. A normal
 * button would activate on that Enter (or Space). This one is out of the tab
 * order and only runs `onActivate` from a real pointer — touch, pen, or mouse.
 */
export function TouchOnlyButton({
  onActivate,
  children,
  className,
  'aria-label': ariaLabel,
  ...rest
}: TouchOnlyButtonProps) {
  const activateFromPointer = (event: PointerEvent<HTMLButtonElement>) => {
    if (!isPointerActivation(event)) return;
    // Keep focus off this control so a following pistol Enter cannot "press" it.
    event.preventDefault();
    onActivate();
  };

  return (
    <button
      {...rest}
      type="button"
      tabIndex={-1}
      aria-label={ariaLabel}
      className={className}
      onPointerDown={activateFromPointer}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
        }
      }}
    >
      {children}
    </button>
  );
}
