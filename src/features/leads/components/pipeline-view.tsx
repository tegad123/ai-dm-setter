'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent
} from '@dnd-kit/core';
import { restrictToWindowEdges } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  LeadStageBadge,
  type LeadStage
} from '@/features/shared/lead-stage-badge';
import { useLeads } from '@/hooks/use-api';
import { useRealtime } from '@/hooks/use-realtime';
import { transitionLeadStage } from '@/lib/api';
import type { Lead } from '@/lib/api';
import { toast } from 'sonner';
import {
  IconChevronRight,
  IconClock,
  IconGripVertical,
  IconSearch,
  IconX
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Stage definitions — order and display names
// ---------------------------------------------------------------------------

const PIPELINE_STAGES: { key: string; label: string }[] = [
  { key: 'NEW_LEAD', label: 'New Lead' },
  { key: 'ENGAGED', label: 'Engaged' },
  { key: 'QUALIFYING', label: 'Qualifying' },
  { key: 'QUALIFIED', label: 'Qualified' },
  { key: 'CALL_PROPOSED', label: 'Call Proposed' },
  { key: 'BOOKED', label: 'Booked' },
  { key: 'SHOWED', label: 'Showed' },
  { key: 'NO_SHOWED', label: 'No Show' },
  { key: 'RESCHEDULED', label: 'Rescheduled' },
  { key: 'CLOSED_WON', label: 'Closed Won' },
  { key: 'CLOSED_LOST', label: 'Closed Lost' },
  { key: 'UNQUALIFIED', label: 'Unqualified' },
  { key: 'GHOSTED', label: 'Ghosted' },
  { key: 'NURTURE', label: 'Nurture' }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeInStage(stageEnteredAt?: string): string {
  if (!stageEnteredAt) return '--';
  const entered = new Date(stageEnteredAt).getTime();
  const now = Date.now();
  const diffMs = now - entered;
  if (diffMs < 0) return 'just now';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function formatRelativeActivity(value?: string | null): string {
  if (!value) return '--';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '--';

  const diffMs = Date.now() - time;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'yesterday';

  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  });
}

function getLeadActivityAt(lead: Lead): string | null {
  return (
    lead.conversation?.lastMessageAt ??
    lead.updatedAt ??
    lead.stageEnteredAt ??
    lead.createdAt ??
    null
  );
}

function displayHandle(handle?: string | null): string {
  if (!handle) return '';
  return handle.startsWith('@') ? handle : `@${handle}`;
}

// ---------------------------------------------------------------------------
// DroppableColumn
// ---------------------------------------------------------------------------

function DroppableColumn({
  stageKey,
  label,
  children,
  count
}: {
  stageKey: string;
  label: string;
  children: React.ReactNode;
  count: number;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: stageKey });

  return (
    <div
      ref={setNodeRef}
      className={`bg-muted/40 flex w-[260px] min-w-[260px] flex-col rounded-lg border transition-colors ${
        isOver ? 'border-primary/50 bg-primary/5' : 'border-border'
      }`}
    >
      {/* Column header */}
      <div className='flex items-center justify-between border-b px-3 py-2.5'>
        <h3 className='text-foreground text-sm font-semibold'>{label}</h3>
        <Badge variant='secondary' className='text-xs tabular-nums'>
          {count}
        </Badge>
      </div>

      {/* Scrollable card list */}
      <div
        className='flex flex-1 flex-col gap-2 overflow-y-auto p-2'
        style={{ maxHeight: 'calc(100vh - 200px)' }}
      >
        {count === 0 ? (
          <div className='border-muted-foreground/25 flex min-h-[100px] items-center justify-center rounded-md border-2 border-dashed p-4'>
            <span className='text-muted-foreground text-xs'>No leads</span>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DraggableCard
// ---------------------------------------------------------------------------

function DraggableCard({ lead, onClick }: { lead: Lead; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: lead.id });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.4 : 1
      }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className='group bg-card cursor-pointer rounded-md border p-3 shadow-sm transition-shadow hover:shadow-md'
      onClick={onClick}
    >
      {/* Drag handle + name row */}
      <div className='flex items-start gap-2'>
        <button
          type='button'
          className='text-muted-foreground mt-0.5 flex-shrink-0 cursor-grab touch-none opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing'
          {...listeners}
          {...attributes}
          onClick={(e) => e.stopPropagation()}
        >
          <IconGripVertical className='h-4 w-4' />
        </button>

        <div className='min-w-0 flex-1'>
          <p className='text-foreground truncate text-sm font-medium'>
            {lead.name}
          </p>
          {lead.handle && (
            <p className='text-muted-foreground truncate text-xs'>
              @{lead.handle}
            </p>
          )}
        </div>
      </div>

      {/* Stage badge */}
      <div className='mt-2'>
        <LeadStageBadge stage={lead.stage.toLowerCase() as LeadStage} />
      </div>

      {/* Quality score bar */}
      <div className='mt-2 flex items-center gap-2'>
        <Progress value={lead.qualityScore ?? 0} className='h-1.5 flex-1' />
        <span className='text-muted-foreground text-[10px] tabular-nums'>
          {lead.qualityScore ?? 0}
        </span>
      </div>

      {/* Time in stage */}
      <div className='text-muted-foreground mt-1.5 flex items-center gap-1'>
        <IconClock className='h-3 w-3' />
        <span className='text-[10px]'>{timeInStage(lead.stageEnteredAt)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LeadCardOverlay — rendered inside DragOverlay for smooth visual feedback
// ---------------------------------------------------------------------------

function LeadCardOverlay({ lead }: { lead: Lead }) {
  return (
    <div className='bg-card w-[244px] rounded-md border p-3 shadow-lg'>
      <div className='flex items-start gap-2'>
        <IconGripVertical className='text-muted-foreground mt-0.5 h-4 w-4 flex-shrink-0' />
        <div className='min-w-0 flex-1'>
          <p className='text-foreground truncate text-sm font-medium'>
            {lead.name}
          </p>
          {lead.handle && (
            <p className='text-muted-foreground truncate text-xs'>
              @{lead.handle}
            </p>
          )}
        </div>
      </div>
      <div className='mt-2'>
        <LeadStageBadge stage={lead.stage.toLowerCase() as LeadStage} />
      </div>
      <div className='mt-2 flex items-center gap-2'>
        <Progress value={lead.qualityScore ?? 0} className='h-1.5 flex-1' />
        <span className='text-muted-foreground text-[10px] tabular-nums'>
          {lead.qualityScore ?? 0}
        </span>
      </div>
      <div className='text-muted-foreground mt-1.5 flex items-center gap-1'>
        <IconClock className='h-3 w-3' />
        <span className='text-[10px]'>{timeInStage(lead.stageEnteredAt)}</span>
      </div>
    </div>
  );
}

function PipelineSearchBar({
  value,
  onChange,
  onClear,
  inputRef,
  resultCount,
  isSearching
}: {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  resultCount: number;
  isSearching: boolean;
}) {
  return (
    <div className='border-border bg-background/95 sticky top-0 z-10 border-b px-4 py-3 backdrop-blur'>
      <div className='flex flex-col gap-2 md:flex-row md:items-center md:justify-between'>
        <div className='relative w-full md:max-w-xl'>
          <IconSearch className='text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder='Search leads by handle, name, ID, phone, or email'
            className='h-10 pr-20 pl-9'
          />
          <div className='absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1'>
            {value ? (
              <Button
                type='button'
                variant='ghost'
                size='icon'
                className='h-7 w-7'
                onClick={onClear}
                aria-label='Clear lead search'
              >
                <IconX className='h-4 w-4' />
              </Button>
            ) : null}
            <span className='text-muted-foreground hidden rounded border px-1.5 py-0.5 text-[10px] font-medium md:inline'>
              ⌘K
            </span>
          </div>
        </div>
        <div className='text-muted-foreground text-xs'>
          {isSearching
            ? `${resultCount} result${resultCount === 1 ? '' : 's'} across all stages`
            : 'Search includes every stage and conversation state'}
        </div>
      </div>
    </div>
  );
}

function LeadSearchRow({ lead, onClick }: { lead: Lead; onClick: () => void }) {
  const activityAt = getLeadActivityAt(lead);
  const coldOrArchived =
    lead.stage === 'GHOSTED' ||
    lead.stage === 'NURTURE' ||
    lead.stage === 'CLOSED_LOST' ||
    lead.stage === 'UNQUALIFIED';

  return (
    <button
      type='button'
      onClick={onClick}
      className='bg-card hover:bg-accent/40 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border p-3 text-left transition-colors md:grid-cols-[minmax(220px,1.4fr)_auto_auto_auto]'
    >
      <div className='min-w-0'>
        <div className='flex items-center gap-2'>
          <p className='text-foreground truncate text-sm font-semibold'>
            {displayHandle(lead.handle) || lead.name}
          </p>
          {coldOrArchived ? (
            <Badge variant='outline' className='text-[10px]'>
              cold
            </Badge>
          ) : null}
        </div>
        <p className='text-muted-foreground mt-0.5 truncate text-xs'>
          {lead.name}
        </p>
        <div className='text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]'>
          <span>ID {lead.id}</span>
          {lead.email || lead.conversation?.leadEmail ? (
            <span>{lead.email ?? lead.conversation?.leadEmail}</span>
          ) : null}
          {lead.conversation?.leadPhone ? (
            <span>{lead.conversation.leadPhone}</span>
          ) : null}
        </div>
      </div>

      <div className='hidden items-center md:flex'>
        <LeadStageBadge stage={lead.stage.toLowerCase() as LeadStage} />
      </div>

      <div className='hidden min-w-[150px] flex-col items-start justify-center gap-1 md:flex'>
        <div className='flex items-center gap-2'>
          <Badge variant='secondary' className='text-[10px]'>
            score {lead.qualityScore ?? 0}
          </Badge>
          {lead.conversation?.aiActive === false ? (
            <Badge variant='outline' className='text-[10px]'>
              AI paused
            </Badge>
          ) : null}
        </div>
        <p className='text-muted-foreground max-w-[210px] truncate text-[11px]'>
          {lead.triggerSource || lead.platform.toLowerCase()}
        </p>
      </div>

      <div className='flex items-center justify-end gap-2'>
        <div className='text-right'>
          <p className='text-muted-foreground text-[11px]'>last activity</p>
          <p className='text-foreground text-xs font-medium'>
            {formatRelativeActivity(activityAt)}
          </p>
          <div className='mt-1 md:hidden'>
            <LeadStageBadge stage={lead.stage.toLowerCase() as LeadStage} />
          </div>
        </div>
        <IconChevronRight className='text-muted-foreground h-4 w-4' />
      </div>
    </button>
  );
}

function PipelineSearchResults({
  query,
  leads,
  latestLeads,
  loading,
  onOpenLead
}: {
  query: string;
  leads: Lead[];
  latestLeads: Lead[];
  loading: boolean;
  onOpenLead: (leadId: string) => void;
}) {
  if (loading) {
    return (
      <div className='space-y-2 p-4'>
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className='h-[92px] w-full rounded-md' />
        ))}
      </div>
    );
  }

  if (leads.length > 0) {
    return (
      <div className='space-y-2 p-4'>
        {leads.map((lead) => (
          <LeadSearchRow
            key={lead.id}
            lead={lead}
            onClick={() => onOpenLead(lead.id)}
          />
        ))}
      </div>
    );
  }

  const withoutAt = query.trim().replace(/^@+/, '');

  return (
    <div className='space-y-4 p-4'>
      <div className='rounded-md border border-dashed p-6'>
        <p className='text-foreground text-sm font-semibold'>
          No leads found matching "{query}"
        </p>
        <div className='text-muted-foreground mt-2 space-y-1 text-sm'>
          {query.trim().startsWith('@') ? (
            <p>Try searching without the @ symbol: "{withoutAt}"</p>
          ) : null}
          <p>Archived, cold, and unqualified leads are included in search.</p>
        </div>
      </div>

      {latestLeads.length > 0 ? (
        <div>
          <p className='text-muted-foreground mb-2 text-xs font-medium'>
            Last 5 leads added
          </p>
          <div className='space-y-2'>
            {latestLeads.slice(0, 5).map((lead) => (
              <LeadSearchRow
                key={lead.id}
                lead={lead}
                onClick={() => onOpenLead(lead.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PipelineView — main export
// ---------------------------------------------------------------------------

export function PipelineView() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const isSearching = debouncedSearch.trim().length > 0;
  const { leads, loading, error, refetch } = useLeads({
    limit: isSearching ? 50 : 500,
    search: isSearching ? debouncedSearch.trim() : undefined
  });
  const { leads: latestLeads, refetch: refetchLatestLeads } = useLeads({
    limit: 5
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<Set<string>>(new Set());

  useRealtime('lead:updated', () => {
    refetch();
    refetchLatestLeads();
  });

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const initial = (query.get('q') ?? query.get('search') ?? '').trim();
    if (!initial) return;
    setSearchInput(initial);
    setDebouncedSearch(initial);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (debouncedSearch.trim()) {
      params.set('q', debouncedSearch.trim());
    } else {
      params.delete('q');
      params.delete('search');
    }
    const qs = params.toString();
    const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    window.history.replaceState(null, '', nextUrl);
  }, [debouncedSearch]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }

      if (
        event.key === 'Escape' &&
        (searchInput || document.activeElement === inputRef.current)
      ) {
        event.preventDefault();
        setSearchInput('');
        setDebouncedSearch('');
        inputRef.current?.blur();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchInput]);

  // Group leads by their UPPER_CASE stage key
  const groupedLeads = useMemo(() => {
    const groups: Record<string, Lead[]> = {};
    for (const s of PIPELINE_STAGES) {
      groups[s.key] = [];
    }
    for (const lead of leads) {
      const key = lead.stage.toUpperCase();
      if (groups[key]) {
        groups[key].push(lead);
      } else {
        // Fallback: put unknown stages into first column
        groups[PIPELINE_STAGES[0].key].push(lead);
      }
    }
    return groups;
  }, [leads]);

  const activeLead = useMemo(
    () => (activeId ? (leads.find((l) => l.id === activeId) ?? null) : null),
    [activeId, leads]
  );

  // Pointer sensor with small activation distance to avoid accidental drags on click
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);

      const { active, over } = event;
      if (!over) return;

      const leadId = String(active.id);
      const newStageKey = String(over.id);

      // Find the lead's current stage
      const lead = leads.find((l) => l.id === leadId);
      if (!lead) return;

      const currentStageKey = lead.stage.toUpperCase();
      if (currentStageKey === newStageKey) return;

      // Prevent concurrent transitions on the same lead
      if (transitioning.has(leadId)) return;

      setTransitioning((prev) => new Set(prev).add(leadId));

      const stageLabel =
        PIPELINE_STAGES.find((s) => s.key === newStageKey)?.label ??
        newStageKey;

      try {
        await transitionLeadStage(
          leadId,
          newStageKey,
          'Moved via pipeline board'
        );
        toast.success(`Moved to ${stageLabel}`);
        refetch();
      } catch (err: any) {
        const message =
          err?.message || err?.error || 'Failed to transition lead stage';
        toast.error(message);
      } finally {
        setTransitioning((prev) => {
          const next = new Set(prev);
          next.delete(leadId);
          return next;
        });
      }
    },
    [leads, transitioning, refetch]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  if (error) {
    return (
      <div className='flex items-center justify-center py-12'>
        <p className='text-muted-foreground text-sm'>
          Failed to load leads. Please try again.
        </p>
      </div>
    );
  }

  return (
    <div className='overflow-hidden rounded-lg border'>
      <PipelineSearchBar
        value={searchInput}
        onChange={setSearchInput}
        onClear={() => {
          setSearchInput('');
          setDebouncedSearch('');
          inputRef.current?.focus();
        }}
        inputRef={inputRef}
        resultCount={leads.length}
        isSearching={isSearching}
      />

      {isSearching ? (
        <PipelineSearchResults
          query={debouncedSearch}
          leads={leads}
          latestLeads={latestLeads}
          loading={loading}
          onOpenLead={(leadId) => router.push(`/dashboard/leads/${leadId}`)}
        />
      ) : loading ? (
        <div className='flex w-max gap-4 p-4'>
          {PIPELINE_STAGES.slice(0, 6).map((s) => (
            <div
              key={s.key}
              className='bg-muted/40 flex w-[260px] min-w-[260px] flex-col rounded-lg border p-3'
            >
              <div className='mb-3 flex items-center justify-between'>
                <Skeleton className='h-4 w-24' />
                <Skeleton className='h-5 w-8 rounded-full' />
              </div>
              <div className='space-y-2'>
                <Skeleton className='h-[100px] w-full rounded-md' />
                <Skeleton className='h-[100px] w-full rounded-md' />
                <Skeleton className='h-[100px] w-full rounded-md' />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          className='overflow-x-auto p-4'
          style={{ maxHeight: 'calc(100dvh - 250px)' }}
        >
          <DndContext
            sensors={sensors}
            modifiers={[restrictToWindowEdges]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className='flex w-max gap-4 pb-4'>
              {PIPELINE_STAGES.map((stage) => {
                const columnLeads = groupedLeads[stage.key] ?? [];
                return (
                  <DroppableColumn
                    key={stage.key}
                    stageKey={stage.key}
                    label={stage.label}
                    count={columnLeads.length}
                  >
                    {columnLeads.map((lead) => (
                      <DraggableCard
                        key={lead.id}
                        lead={lead}
                        onClick={() =>
                          router.push(`/dashboard/leads/${lead.id}`)
                        }
                      />
                    ))}
                  </DroppableColumn>
                );
              })}
            </div>

            <DragOverlay dropAnimation={null}>
              {activeLead ? <LeadCardOverlay lead={activeLead} /> : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}
    </div>
  );
}
