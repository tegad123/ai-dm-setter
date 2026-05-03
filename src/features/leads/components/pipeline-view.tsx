'use client';

import { useState, useMemo, useCallback } from 'react';
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
import { IconGripVertical, IconClock } from '@tabler/icons-react';

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

// ---------------------------------------------------------------------------
// PipelineView — main export
// ---------------------------------------------------------------------------

export function PipelineView() {
  const router = useRouter();
  const { leads, loading, error, refetch } = useLeads({ limit: 500 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<Set<string>>(new Set());

  useRealtime('lead:updated', () => {
    refetch();
  });

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

  // Loading state
  if (loading) {
    return (
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
    );
  }

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
    <div
      className='overflow-x-auto'
      style={{ maxHeight: 'calc(100dvh - 180px)' }}
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
                    onClick={() => router.push(`/dashboard/leads/${lead.id}`)}
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
  );
}
