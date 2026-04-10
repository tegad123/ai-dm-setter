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
import {
  LeadStatusBadge,
  allStatuses
} from '@/features/shared/lead-status-badge';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { useState, useMemo } from 'react';
import { IconSearch } from '@tabler/icons-react';
import { useLeads, useTags } from '@/hooks/use-api';
import type { LeadStatus } from '@/features/shared/lead-status-badge';

export function LeadsTable() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [platformFilter, setPlatformFilter] = useState<string>('all');

  const { tags: availableTags } = useTags();

  // Map lowercase status filter to UPPER_CASE for the API
  const apiStatus =
    statusFilter !== 'all' ? statusFilter.toUpperCase() : undefined;

  const {
    leads: apiLeads,
    total,
    loading,
    error
  } = useLeads({
    status: apiStatus,
    search: search || undefined,
    tag: tagFilter !== 'all' ? tagFilter : undefined,
    platform: platformFilter !== 'all' ? platformFilter : undefined,
    limit: 100
  });

  // Map API response fields to match what the UI expects
  const leads = useMemo(() => {
    return apiLeads.map((lead: any) => ({
      id: lead.id,
      fullName: lead.name,
      username: lead.handle,
      platform: lead.platform.toLowerCase() as 'instagram' | 'facebook',
      status: lead.status.toLowerCase() as LeadStatus,
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
              <SelectValue placeholder='Filter by status' />
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
            onChange={(e) => setSearch(e.target.value)}
            className='pl-9'
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className='w-[200px]'>
            <SelectValue placeholder='Filter by status' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All Statuses</SelectItem>
            {allStatuses.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tagFilter} onValueChange={setTagFilter}>
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
        <Select value={platformFilter} onValueChange={setPlatformFilter}>
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
          <span className='text-foreground font-medium'>{leads.length}</span> of{' '}
          {total} leads
        </span>
      </div>

      {/* Table */}
      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Status</TableHead>
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
                <TableRow key={lead.id}>
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
                    <LeadStatusBadge status={lead.status} />
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
    </div>
  );
}
