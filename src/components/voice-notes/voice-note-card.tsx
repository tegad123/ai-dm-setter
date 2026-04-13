'use client';

import { useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Loader2,
  Play,
  Pause,
  AlertCircle,
  CheckCircle2,
  Clock
} from 'lucide-react';
import type { VoiceNoteLibraryItem } from '@/lib/api';

interface VoiceNoteCardProps {
  item: VoiceNoteLibraryItem;
  onToggleActive: (id: string, active: boolean) => void;
  onClick: (id: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatLabel(tag: string): string {
  return tag.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusConfig(status: VoiceNoteLibraryItem['status']) {
  switch (status) {
    case 'PROCESSING':
      return {
        label: 'Processing',
        className: 'bg-blue-100 text-blue-800 border-blue-300',
        icon: Loader2
      };
    case 'NEEDS_REVIEW':
      return {
        label: 'Needs Review',
        className: 'bg-amber-100 text-amber-800 border-amber-300',
        icon: Clock
      };
    case 'ACTIVE':
      return {
        label: 'Active',
        className: 'bg-green-100 text-green-800 border-green-300',
        icon: CheckCircle2
      };
    case 'DISABLED':
      return {
        label: 'Disabled',
        className: 'border-gray-300 bg-gray-100 text-gray-800',
        icon: null
      };
    case 'FAILED':
      return {
        label: 'Failed',
        className: 'bg-red-100 text-red-800 border-red-300',
        icon: AlertCircle
      };
  }
}

export default function VoiceNoteCard({
  item,
  onToggleActive,
  onClick
}: VoiceNoteCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const status = statusConfig(item.status);
  const StatusIcon = status.icon;

  function handlePlayToggle(e: React.MouseEvent) {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  }

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    onToggleActive(item.id, !item.active);
  }

  const maxChips = 3;
  const visibleCases = item.useCases.slice(0, maxChips);
  const extraCount = item.useCases.length - maxChips;

  return (
    <Card
      className='cursor-pointer transition-shadow hover:shadow-md'
      onClick={() => onClick(item.id)}
    >
      <CardContent className='flex items-start gap-4 py-4'>
        {/* Play button */}
        <Button
          variant='outline'
          size='icon'
          className='mt-0.5 h-10 w-10 shrink-0 rounded-full'
          onClick={handlePlayToggle}
          disabled={item.status === 'PROCESSING'}
        >
          <Play className='h-4 w-4' />
        </Button>
        <audio ref={audioRef} src={item.audioFileUrl} preload='none' />

        {/* Content */}
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <h3 className='truncate font-medium'>
              {item.userLabel || 'Untitled Voice Note'}
            </h3>
            <Badge className={status.className}>
              {StatusIcon &&
                (StatusIcon === Loader2 ? (
                  <Loader2 className='mr-1 h-3 w-3 animate-spin' />
                ) : (
                  <StatusIcon className='mr-1 h-3 w-3' />
                ))}
              {status.label}
            </Badge>
            <Badge variant='outline' className='text-xs'>
              {formatDuration(item.durationSeconds)}
            </Badge>
          </div>

          {item.summary && (
            <p className='text-muted-foreground mt-1 line-clamp-2 text-sm'>
              {item.summary}
            </p>
          )}

          {item.triggerDescription && (
            <p className='text-muted-foreground mt-1 text-xs italic'>
              {item.triggerDescription}
            </p>
          )}

          {visibleCases.length > 0 && (
            <div className='mt-2 flex flex-wrap gap-1'>
              {visibleCases.map((uc) => (
                <Badge key={uc} variant='secondary' className='text-xs'>
                  {formatLabel(uc)}
                </Badge>
              ))}
              {extraCount > 0 && (
                <Badge variant='secondary' className='text-xs'>
                  +{extraCount} more
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* Active toggle */}
        {(item.status === 'ACTIVE' || item.status === 'DISABLED') && (
          <Button
            variant={item.active ? 'default' : 'outline'}
            size='sm'
            className='shrink-0'
            onClick={handleToggle}
          >
            {item.active ? 'Active' : 'Disabled'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
