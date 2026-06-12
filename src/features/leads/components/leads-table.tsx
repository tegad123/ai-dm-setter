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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { LeadStageBadge, allStages } from '@/features/shared/lead-stage-badge';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { IconSearch } from '@tabler/icons-react';
import { useLeads, useTags } from '@/hooks/use-api';
import type { LeadStage } from '@/features/shared/lead-stage-badge';

// Grouped stage filters that reconcile with Analytics. Each value is a
// comma-separated stage list the /api/leads `stage` param matches with `in`.
// "Booked" returns every lead that has been on the calendar (incl. ones that
// progressed to Showed / Closed), so this filter's count matches the Overview
// "Booked" KPI — instead of exact-BOOKED which misses downstream leads.
const GROUPED_STAGE_FILTERS = [
  {
    value: 'QUALIFIED,CALL_PROPOSED,BOOKED,SHOWED,CLOSED_WON',
    label: 'Qualified (all)'
  },
  {
    value: 'BOOKED,SHOWED,NO_SHOWED,RESCHEDULED,CLOSED_WON',
    label: 'Booked (incl. showed/closed)'
  },
  { value: 'SHOWED,CLOSED_WON', label: 'Showed up' }
];

export function LeadsTable() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  const { tags: availableTags } = useTags();

  // Map stage filter to the API param. Single exact stages are lowercase
  // (from allStages) → uppercased; grouped filters are already an uppercase
  // comma list and pass through unchanged.
  const apiStage =
    stageFilter !== 'all' ? stageFilter.toUpperCase() : undefined;

  // Any filter/search change resets to page 1 so we don't land on an empty
  // page beyond the new result set.
  const resetPage = () => setPage(1);

  const {
    leads: apiLeads,
    total,
    loading,
    error
  } = useLeads({
    stage: apiStage,
    search: search || undefined,
    tag: tagFilter !== 'all' ? tagFilter : undefined,
    platform: platformFilter !== 'all' ? platformFilter : undefined,
    page,
    limit: PAGE_SIZE
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  // Map API response fields to match what the UI expects
  const leads = useMemo(() => {
    return apiLeads.map((lead: any) => ({
      id: lead.id,
      fullName: lead.name,
      username: lead.handle,
      platform: lead.platform.toLowerCase() as 'instagram' | 'facebook',
      stage: lead.stage.toLowerCase() as LeadStage,
      qualityScore: lead.qualityScore ?? 0,
      triggerType: lead.triggerType === 'DM' ? 'direct_dm' : 'comment',
      tags: (lead.tags ?? []).map((lt: any) => ({
        id: lt.tag.id,
        name: lt.tag.name,
        color: lt.tag.color
      })),
      bookingSlot: lead.bookedAt
        ? new Date(lead.bookedAt).toLocaleDateString('en-US', {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })
        : undefined,
      revenue: lead.revenue ?? undefined,
      lastMessageAt: lead.updatedAt
    }));
  }, [apiLeads]);

  if (loading) {
    return (
      <div className='space-y-4'>
        <div className='flex flex-col gap-4 sm:flex-row'>
          <div className='relative flex-1'>
            <IconSearch className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
            <Input
              placeholder='Search leads...'
              disabled
              className='pl-9'
              value=''
              readOnly
            />
          </div>
          <Select disabled>
            <SelectTrigger className='w-[200px]'>
              <SelectValue placeholder='Filter by stage' />
            </SelectTrigger>
          </Select>
        </div>
        <div className='text-muted-foreground py-8 text-center text-sm'>
          Loading leads...
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      {/* Filters */}
      <div className='flex flex-col gap-4 sm:flex-row'>
        <div className='relative flex-1'>
          <IconSearch className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            placeholder='Search leads...'
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPage();
            }}
            className='pl-9'
          />
        </div>
        <Select
          value={stageFilter}
          onValueChange={(v) => {
            setStageFilter(v);
            resetPage();
          }}
        >
          <SelectTrigger className='w-[200px]'>
            <SelectValue placeholder='Filter by stage' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All Stages</SelectItem>
            {GROUPED_STAGE_FILTERS.map((g) => (
              <SelectItem key={g.value} value={g.value}>
                {g.label}
              </SelectItem>
            ))}
            <div className='bg-border my-1 h-px' />
            {allStages.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={tagFilter}
          onValueChange={(v) => {
            setTagFilter(v);
            resetPage();
          }}
        >
          <SelectTrigger className='w-[180px]'>
            <SelectValue placeholder='Filter by tag' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All Tags</SelectItem>
            {availableTags.map((t) => (
              <SelectItem key={t.id} value={t.name}>
                <div className='flex items-center gap-2'>
                  <span
                    className='inline-block h-2 w-2 rounded-full'
                    style={{ backgroundColor: t.color }}
                  />
                  {t.name.replace(/_/g, ' ')}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={platformFilter}
          onValueChange={(v) => {
            setPlatformFilter(v);
            resetPage();
          }}
        >
          <SelectTrigger className='w-[160px]'>
            <SelectValue placeholder='Platform' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All Platforms</SelectItem>
            <SelectItem value='INSTAGRAM'>Instagram</SelectItem>
            <SelectItem value='FACEBOOK'>Facebook</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stats Bar */}
      <div className='flex gap-4 text-sm'>
        <span className='text-muted-foreground'>
          Showing{' '}
          <span className='text-foreground font-medium'>
            {rangeStart}–{rangeEnd}
          </span>{' '}
          of {total} leads
        </span>
      </div>

      {/* Table */}
      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Quality</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Booking</TableHead>
              <TableHead>Revenue</TableHead>
              <TableHead className='text-right'>Last Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className='text-muted-foreground py-8 text-center'
                >
                  {error ? 'Failed to load leads.' : 'No leads found.'}
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => (
                <TableRow
                  key={lead.id}
                  onClick={() => router.push(`/dashboard/leads/${lead.id}`)}
                  className='hover:bg-muted/50 cursor-pointer'
                >
                  <TableCell>
                    <div>
                      <p className='font-medium'>{lead.fullName}</p>
                      <p className='text-muted-foreground text-xs'>
                        @{lead.username}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <PlatformIcon platform={lead.platform} />
                  </TableCell>
                  <TableCell>
                    <LeadStageBadge stage={lead.stage} />
                  </TableCell>
                  <TableCell>
                    <div className='flex flex-wrap gap-1'>
                      {lead.tags.length > 0 ? (
                        lead.tags.map((tag: any) => (
                          <TagBadge
                            key={tag.id}
                            name={tag.name}
                            color={tag.color}
                          />
                        ))
                      ) : (
                        <span className='text-muted-foreground text-xs'>—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className='flex items-center gap-2'>
                      <Progress
                        value={lead.qualityScore}
                        className='h-2 w-16'
                      />
                      <span className='text-xs tabular-nums'>
                        {lead.qualityScore}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant='outline' className='text-xs capitalize'>
                      {lead.triggerType === 'direct_dm' ? 'DM' : 'Comment'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {lead.bookingSlot ? (
                      <span className='text-xs'>{lead.bookingSlot}</span>
                    ) : (
                      <span className='text-muted-foreground text-xs'>—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {lead.revenue ? (
                      <span className='font-medium text-emerald-600'>
                        ${lead.revenue.toLocaleString()}
                      </span>
                    ) : (
                      <span className='text-muted-foreground text-xs'>—</span>
                    )}
                  </TableCell>
                  <TableCell className='text-right'>
                    <span className='text-muted-foreground text-xs'>
                      {new Date(lead.lastMessageAt).toLocaleDateString(
                        'en-US',
                        { month: 'short', day: 'numeric' }
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination controls */}
      {total > PAGE_SIZE && (
        <div className='flex items-center justify-between pt-2'>
          <span className='text-muted-foreground text-sm'>
            Page <span className='text-foreground font-medium'>{page}</span> of{' '}
            {totalPages}
          </span>
          <div className='flex gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
