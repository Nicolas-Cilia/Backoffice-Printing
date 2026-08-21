import type { Transform } from '@dnd-kit/utilities';

export function clampArrangeDrag(
  transform: Transform,
  dragging: { top: number; bottom: number } | null | undefined,
  list: { top: number; bottom: number } | null | undefined,
): Transform {
  if (!dragging || !list) {
    return { ...transform, x: 0 };
  }
  const yMin = list.top - dragging.top;
  const yMax = list.bottom - dragging.bottom;
  return {
    ...transform,
    x: 0,
    y: Math.min(Math.max(transform.y, yMin), yMax),
  };
}
