'use client';

import { Badge } from '@/components/ui/badge';
import { IconX } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

interface TagBadgeProps {
  name: string;
  color: string;
  size?: 'sm' | 'md';
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
}

export function TagBadge({
  name,
  color,
  size = 'sm',
  removable = false,
  onRemove,
  className
}: TagBadgeProps) {
  // Format the display name: UPPER_SNAKE → Title Case
  const displayName = name
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <Badge
      variant='outline'
      className={cn(
        'gap-1 border font-medium whitespace-nowrap',
        size === 'sm' && 'px-1.5 py-0 text-[10px]',
        size === 'md' && 'px-2 py-0.5 text-xs',
        className
      )}
      style={{
        borderColor: color,
        color: color,
        backgroundColor: `${color}15`
      }}
    >
      <span
        className='inline-block h-1.5 w-1.5 rounded-full'
        style={{ backgroundColor: color }}
      />
      {displayName}
      {removable && onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className='ml-0.5 rounded-full p-0 hover:opacity-70'
        >
          <IconX className='h-2.5 w-2.5' />
        </button>
      )}
    </Badge>
  );
}
