import type { CSSProperties } from 'react';

/**
 * Get pinning styles for data table columns.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCommonPinningStyles(column: any): CSSProperties {
  const isPinned = column.getIsPinned?.();
  const isLastLeftPinned =
    isPinned === 'left' && column.getIsLastColumn?.('left');
  const isFirstRightPinned =
    isPinned === 'right' && column.getIsFirstColumn?.('right');

  return {
    boxShadow: isLastLeftPinned
      ? '-4px 0 4px -4px gray inset'
      : isFirstRightPinned
        ? '4px 0 4px -4px gray inset'
        : undefined,
    left: isPinned === 'left' ? `${column.getStart?.('left') ?? 0}px` : undefined,
    right: isPinned === 'right' ? `${column.getAfter?.('right') ?? 0}px` : undefined,
    opacity: isPinned ? 0.97 : 1,
    position: isPinned ? 'sticky' : 'relative',
    background: isPinned ? 'inherit' : undefined,
    width: column.getSize?.(),
    zIndex: isPinned ? 1 : 0
  };
}
