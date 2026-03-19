'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ActivityHeatmapProps {
  heatmap: Record<string, number>; // "dayOfWeek-hour" -> count
  title?: string;
  description?: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function getIntensity(count: number, maxCount: number): string {
  if (count === 0) return 'bg-muted';
  const ratio = count / maxCount;
  if (ratio > 0.75) return 'bg-primary';
  if (ratio > 0.5) return 'bg-primary/70';
  if (ratio > 0.25) return 'bg-primary/40';
  return 'bg-primary/20';
}

function formatHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return '12p';
  return `${hour - 12}p`;
}

export function ActivityHeatmap({
  heatmap,
  title = 'Activity Heatmap',
  description = 'Message volume by day and hour'
}: ActivityHeatmapProps) {
  const maxCount = Math.max(1, ...Object.values(heatmap));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <TooltipProvider>
          <div className='overflow-x-auto'>
            {/* Hour labels */}
            <div className='mb-1 flex pl-10'>
              {HOURS.map((h) => (
                <div
                  key={h}
                  className='text-muted-foreground flex-1 text-center text-[9px]'
                >
                  {h % 3 === 0 ? formatHour(h) : ''}
                </div>
              ))}
            </div>

            {/* Grid rows */}
            <div className='space-y-1'>
              {DAYS.map((day, dayIndex) => (
                <div key={day} className='flex items-center gap-1'>
                  <span className='text-muted-foreground w-9 text-right text-[10px]'>
                    {day}
                  </span>
                  <div className='flex flex-1 gap-0.5'>
                    {HOURS.map((hour) => {
                      const key = `${dayIndex}-${hour}`;
                      const count = heatmap[key] || 0;
                      return (
                        <Tooltip key={key}>
                          <TooltipTrigger asChild>
                            <div
                              className={cn(
                                'h-4 flex-1 rounded-sm transition-colors',
                                getIntensity(count, maxCount)
                              )}
                            />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className='text-xs'>
                              {day} {formatHour(hour)} — {count} message
                              {count !== 1 ? 's' : ''}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Legend */}
            <div className='mt-3 flex items-center justify-end gap-1.5'>
              <span className='text-muted-foreground text-[10px]'>Less</span>
              <div className='bg-muted h-3 w-3 rounded-sm' />
              <div className='bg-primary/20 h-3 w-3 rounded-sm' />
              <div className='bg-primary/40 h-3 w-3 rounded-sm' />
              <div className='bg-primary/70 h-3 w-3 rounded-sm' />
              <div className='bg-primary h-3 w-3 rounded-sm' />
              <span className='text-muted-foreground text-[10px]'>More</span>
            </div>
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
