'use client';

import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IconTag, IconCheck, IconSearch } from '@tabler/icons-react';
import { TagBadge } from './tag-badge';
import { cn } from '@/lib/utils';

interface TagOption {
  id: string;
  name: string;
  color: string;
  isAuto: boolean;
}

interface TagPickerProps {
  availableTags: TagOption[];
  selectedTagIds: string[];
  onTagAdd: (tagId: string) => void;
  onTagRemove: (tagId: string) => void;
  disabled?: boolean;
}

export function TagPicker({
  availableTags,
  selectedTagIds,
  onTagAdd,
  onTagRemove,
  disabled = false
}: TagPickerProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const filteredTags = availableTags.filter((tag) =>
    tag.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='h-7 gap-1 text-xs'
          disabled={disabled}
        >
          <IconTag className='h-3 w-3' />
          Add Tag
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-56 p-2' align='start'>
        <div className='relative mb-2'>
          <IconSearch className='text-muted-foreground absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2' />
          <Input
            placeholder='Search tags...'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className='h-8 pl-7 text-xs'
          />
        </div>
        <ScrollArea className='max-h-48'>
          <div className='space-y-0.5'>
            {filteredTags.length === 0 ? (
              <p className='text-muted-foreground py-2 text-center text-xs'>
                No tags found
              </p>
            ) : (
              filteredTags.map((tag) => {
                const isSelected = selectedTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => {
                      if (isSelected) {
                        onTagRemove(tag.id);
                      } else {
                        onTagAdd(tag.id);
                      }
                    }}
                    className={cn(
                      'hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                      isSelected && 'bg-accent'
                    )}
                  >
                    <span
                      className='h-2.5 w-2.5 rounded-full'
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className='flex-1'>
                      {tag.name.replace(/_/g, ' ')}
                    </span>
                    {isSelected && (
                      <IconCheck className='text-primary h-3.5 w-3.5' />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
