'use client';

import { useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { createStep, deleteStep, reorderSteps } from '@/lib/api';
import type { ScriptStep } from '@/lib/script-types';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Sortable Step Item
// ---------------------------------------------------------------------------

function SortableStepItem({
  step,
  isActive,
  onClick,
  onDelete,
  totalSteps
}: {
  step: ScriptStep;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  totalSteps: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex cursor-pointer items-center gap-1 rounded px-2 py-2 text-sm transition-colors',
        isActive
          ? 'bg-primary/10 text-primary border-primary/30 border font-medium'
          : 'hover:bg-muted/50 border border-transparent'
      )}
      onClick={onClick}
    >
      <button
        className='text-muted-foreground hover:text-foreground shrink-0 cursor-grab'
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className='h-3.5 w-3.5' />
      </button>

      <span className='text-muted-foreground w-5 shrink-0 text-right text-xs'>
        {step.stepNumber}.
      </span>

      <span className='flex-1 truncate'>{step.title}</span>

      {totalSteps > 1 && (
        <button
          className='shrink-0 text-red-500 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-700'
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step Sidebar
// ---------------------------------------------------------------------------

interface StepSidebarProps {
  steps: ScriptStep[];
  scriptId: string;
  activeStepId: string | null;
  onSelectStep: (stepId: string) => void;
  onStepsChange: (steps: ScriptStep[]) => void;
}

export default function StepSidebar({
  steps,
  scriptId,
  activeStepId,
  onSelectStep,
  onStepsChange
}: StepSidebarProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = steps.findIndex((s) => s.id === active.id);
      const newIndex = steps.findIndex((s) => s.id === over.id);
      const reordered = arrayMove(steps, oldIndex, newIndex).map((s, i) => ({
        ...s,
        stepNumber: i + 1
      }));

      onStepsChange(reordered);

      try {
        await reorderSteps(
          scriptId,
          reordered.map((s) => s.id)
        );
      } catch {
        toast.error('Failed to save order');
      }
    },
    [steps, scriptId, onStepsChange]
  );

  const handleAddStep = async () => {
    try {
      const result = await createStep(scriptId, {
        title: `Step ${steps.length + 1}`
      });
      const newStep = {
        ...result,
        stepNumber: steps.length + 1,
        branches: result.branches || [],
        actions: result.actions || []
      };
      onStepsChange([...steps, newStep]);
      onSelectStep(newStep.id);
    } catch {
      toast.error('Failed to add step');
    }
  };

  const handleDeleteStep = async (stepId: string) => {
    try {
      await deleteStep(scriptId, stepId);
      const remaining = steps
        .filter((s) => s.id !== stepId)
        .map((s, i) => ({ ...s, stepNumber: i + 1 }));
      onStepsChange(remaining);
      if (activeStepId === stepId && remaining.length > 0) {
        onSelectStep(remaining[0].id);
      }
    } catch {
      toast.error('Failed to delete step');
    }
  };

  return (
    <div className='flex h-full flex-col'>
      <div className='flex items-center justify-between px-3 pb-2'>
        <h3 className='text-sm font-semibold'>Steps</h3>
        <span className='text-muted-foreground text-xs'>{steps.length}</span>
      </div>

      <div className='flex-1 space-y-1 overflow-y-auto px-1'>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            {steps.map((step) => (
              <SortableStepItem
                key={step.id}
                step={step}
                isActive={step.id === activeStepId}
                onClick={() => onSelectStep(step.id)}
                onDelete={() => handleDeleteStep(step.id)}
                totalSteps={steps.length}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <div className='px-1 pt-2'>
        <Button
          variant='outline'
          size='sm'
          className='w-full'
          onClick={handleAddStep}
        >
          <Plus className='mr-1 h-3 w-3' />
          Add Step
        </Button>
      </div>
    </div>
  );
}
