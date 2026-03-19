'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { TagBadge } from './tag-badge';
import { useTags } from '@/hooks/use-api';
import { createTag, deleteTag } from '@/lib/api';
import { IconPlus, IconTrash, IconRobot } from '@tabler/icons-react';
import { toast } from 'sonner';

const TAG_COLORS = [
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#14B8A6',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#6B7280',
  '#F59E0B'
];

export function TagManager() {
  const { tags, loading, refetch } = useTags();
  const [newTagName, setNewTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState(TAG_COLORS[0]);
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newTagName.trim()) return;
    setCreating(true);
    try {
      await createTag({ name: newTagName.trim(), color: selectedColor });
      setNewTagName('');
      refetch();
      toast.success('Tag created');
    } catch (err: any) {
      toast.error(err.message || 'Failed to create tag');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (tagId: string, tagName: string) => {
    try {
      await deleteTag(tagId);
      refetch();
      toast.success(`Deleted tag "${tagName}"`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete tag');
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className='h-6 w-32' />
          <Skeleton className='h-4 w-64' />
        </CardHeader>
        <CardContent>
          <div className='space-y-2'>
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className='h-8 w-full' />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
        <CardDescription>
          Manage tags for organizing and categorizing your leads. AI auto-tags
          are applied automatically during conversations.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-6'>
        {/* Create new tag */}
        <div className='flex items-end gap-3'>
          <div className='flex-1 space-y-1.5'>
            <label className='text-sm font-medium'>New Tag</label>
            <Input
              placeholder='e.g. HOT PROSPECT'
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
          </div>
          <div className='space-y-1.5'>
            <label className='text-sm font-medium'>Color</label>
            <div className='flex gap-1'>
              {TAG_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setSelectedColor(color)}
                  className='h-7 w-7 rounded-md border-2 transition-all'
                  style={{
                    backgroundColor: color,
                    borderColor:
                      selectedColor === color ? 'white' : 'transparent',
                    outline:
                      selectedColor === color ? `2px solid ${color}` : 'none'
                  }}
                />
              ))}
            </div>
          </div>
          <Button
            onClick={handleCreate}
            disabled={creating || !newTagName.trim()}
            size='sm'
          >
            <IconPlus className='mr-1 h-4 w-4' />
            Create
          </Button>
        </div>

        {/* Tag list */}
        <div className='space-y-2'>
          {tags.length === 0 ? (
            <p className='text-muted-foreground py-4 text-center text-sm'>
              No tags yet. Create your first tag above.
            </p>
          ) : (
            tags.map((tag) => (
              <div
                key={tag.id}
                className='flex items-center justify-between rounded-md border px-3 py-2'
              >
                <div className='flex items-center gap-3'>
                  <TagBadge name={tag.name} color={tag.color} size='md' />
                  {tag.isAuto && (
                    <Badge variant='secondary' className='gap-1 text-[10px]'>
                      <IconRobot className='h-3 w-3' />
                      Auto
                    </Badge>
                  )}
                  <span className='text-muted-foreground text-xs'>
                    {tag.leadsCount} lead{tag.leadsCount !== 1 ? 's' : ''}
                  </span>
                </div>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-7 w-7'
                  onClick={() => handleDelete(tag.id, tag.name)}
                >
                  <IconTrash className='h-4 w-4 text-red-500' />
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
