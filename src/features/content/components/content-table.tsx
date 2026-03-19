'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { useContentAttributions } from '@/hooks/use-api';
import type { ContentAttribution } from '@/lib/api';
import { useState } from 'react';
import {
  IconMovie,
  IconClockHour4,
  IconPhoto,
  IconBroadcast,
  IconAd,
  IconMessage,
  IconArrowRight
} from '@tabler/icons-react';

const contentTypeIcons: Record<string, React.ReactNode> = {
  REEL: <IconMovie className='h-4 w-4 text-pink-500' />,
  STORY: <IconClockHour4 className='h-4 w-4 text-purple-500' />,
  POST: <IconPhoto className='h-4 w-4 text-blue-500' />,
  LIVE: <IconBroadcast className='h-4 w-4 text-red-500' />,
  AD: <IconAd className='h-4 w-4 text-amber-500' />,
  COMMENT_TRIGGER: <IconMessage className='h-4 w-4 text-green-500' />,
  DM_DIRECT: <IconArrowRight className='h-4 w-4 text-gray-500' />
};

export function ContentTable() {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('leadsCount');

  const { content, total, totals, loading } = useContentAttributions({
    contentType: typeFilter !== 'all' ? typeFilter : undefined,
    sortBy,
    limit: 50
  });

  if (loading) {
    return (
      <div className='space-y-4'>
        <div className='flex gap-4'>
          <Skeleton className='h-9 w-[200px]' />
          <Skeleton className='h-9 w-[200px]' />
        </div>
        <div className='space-y-2'>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className='h-12 w-full' />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      {/* Summary cards */}
      <div className='grid grid-cols-3 gap-4'>
        <div className='rounded-lg border p-4'>
          <p className='text-muted-foreground text-xs font-medium'>
            Total Leads from Content
          </p>
          <p className='text-2xl font-bold'>{totals.totalLeads}</p>
        </div>
        <div className='rounded-lg border p-4'>
          <p className='text-muted-foreground text-xs font-medium'>
            Revenue from Content
          </p>
          <p className='text-2xl font-bold text-emerald-600'>
            ${totals.totalRevenue.toLocaleString()}
          </p>
        </div>
        <div className='rounded-lg border p-4'>
          <p className='text-muted-foreground text-xs font-medium'>
            Calls Booked
          </p>
          <p className='text-2xl font-bold'>{totals.totalCallsBooked}</p>
        </div>
      </div>

      {/* Filters */}
      <div className='flex gap-3'>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className='w-[180px]'>
            <SelectValue placeholder='Content Type' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All Types</SelectItem>
            <SelectItem value='REEL'>Reels</SelectItem>
            <SelectItem value='STORY'>Stories</SelectItem>
            <SelectItem value='POST'>Posts</SelectItem>
            <SelectItem value='LIVE'>Lives</SelectItem>
            <SelectItem value='AD'>Ads</SelectItem>
            <SelectItem value='DM_DIRECT'>Direct DMs</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className='w-[180px]'>
            <SelectValue placeholder='Sort by' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='leadsCount'>Most Leads</SelectItem>
            <SelectItem value='revenue'>Most Revenue</SelectItem>
            <SelectItem value='callsBooked'>Most Calls</SelectItem>
            <SelectItem value='createdAt'>Most Recent</SelectItem>
          </SelectContent>
        </Select>
        <span className='text-muted-foreground flex items-center text-sm'>
          {total} content piece{total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Content</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead className='text-right'>Leads</TableHead>
              <TableHead className='text-right'>Calls</TableHead>
              <TableHead className='text-right'>Revenue</TableHead>
              <TableHead className='text-right'>Conv. Rate</TableHead>
              <TableHead className='text-right'>Posted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {content.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className='text-muted-foreground py-8 text-center'
                >
                  No content attributions found.
                </TableCell>
              </TableRow>
            ) : (
              content.map((item: ContentAttribution) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className='flex items-center gap-2'>
                      {contentTypeIcons[item.contentType] ?? (
                        <IconPhoto className='h-4 w-4' />
                      )}
                      <div className='max-w-[300px]'>
                        <Badge variant='outline' className='mb-0.5 text-[10px]'>
                          {item.contentType.replace(/_/g, ' ')}
                        </Badge>
                        {item.caption && (
                          <p className='text-muted-foreground truncate text-xs'>
                            {item.caption}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <PlatformIcon
                      platform={
                        item.platform.toLowerCase() as 'instagram' | 'facebook'
                      }
                    />
                  </TableCell>
                  <TableCell className='text-right font-medium'>
                    {item.leadsCount}
                  </TableCell>
                  <TableCell className='text-right'>
                    {item.callsBooked}
                  </TableCell>
                  <TableCell className='text-right'>
                    {item.revenue > 0 ? (
                      <span className='font-medium text-emerald-600'>
                        ${item.revenue.toLocaleString()}
                      </span>
                    ) : (
                      <span className='text-muted-foreground'>—</span>
                    )}
                  </TableCell>
                  <TableCell className='text-right'>
                    <span
                      className={
                        item.conversionRate > 30
                          ? 'font-medium text-emerald-600'
                          : item.conversionRate > 10
                            ? 'text-amber-600'
                            : 'text-muted-foreground'
                      }
                    >
                      {item.conversionRate}%
                    </span>
                  </TableCell>
                  <TableCell className='text-right'>
                    {item.postedAt ? (
                      <span className='text-muted-foreground text-xs'>
                        {new Date(item.postedAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric'
                        })}
                      </span>
                    ) : (
                      <span className='text-muted-foreground text-xs'>—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
