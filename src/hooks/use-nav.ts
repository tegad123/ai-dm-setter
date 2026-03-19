'use client';

import { useMemo } from 'react';
import type { NavItem } from '@/types';

/**
 * Simple nav filtering hook (Clerk stripped).
 * Returns all items — no RBAC filtering for now.
 */
export function useFilteredNavItems(items: NavItem[]) {
  const filteredItems = useMemo(() => {
    return items;
  }, [items]);

  return filteredItems;
}
