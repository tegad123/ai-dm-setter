import { z } from 'zod';
import { createParser } from 'nuqs';
import type { SortingState } from '@tanstack/react-table';

// ---------------------------------------------------------------------------
// Data Table Filter Schema
// ---------------------------------------------------------------------------

export const FilterItemSchema = z.object({
  id: z.string(),
  value: z.union([z.string(), z.array(z.string())])
});

export type FilterItem = z.infer<typeof FilterItemSchema>;

// ---------------------------------------------------------------------------
// Sorting State Parser — compatible with nuqs useQueryState
// ---------------------------------------------------------------------------

export function getSortingStateParser<TData = unknown>(
  columnIds?: Set<string>
) {
  return createParser<SortingState>({
    parse: (value: string) => {
      if (!value) return null;
      try {
        const parsed = JSON.parse(value) as SortingState;
        if (!Array.isArray(parsed)) return null;
        if (columnIds) {
          return parsed.filter((s) => columnIds.has(s.id));
        }
        return parsed;
      } catch {
        return null;
      }
    },
    serialize: (value: SortingState) => JSON.stringify(value)
  });
}
