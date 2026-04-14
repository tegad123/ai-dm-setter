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
  arrayMove
} from '@dnd-kit/sortable';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import ActionCard from './action-card';
import { createAction, updateAction } from '@/lib/api';
import type { ScriptAction, ScriptForm } from '@/lib/script-types';
import { toast } from 'sonner';

interface ActionListProps {
  actions: ScriptAction[];
  scriptId: string;
  stepId: string;
  branchId?: string | null;
  forms: ScriptForm[];
  onActionsChange: (actions: ScriptAction[]) => void;
}

export default function ActionList({
  actions,
  scriptId,
  stepId,
  branchId,
  forms,
  onActionsChange
}: ActionListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = actions.findIndex((a) => a.id === active.id);
      const newIndex = actions.findIndex((a) => a.id === over.id);
      const reordered = arrayMove(actions, oldIndex, newIndex);
      onActionsChange(reordered);

      // Persist sort orders
      try {
        await Promise.all(
          reordered.map((a, i) =>
            updateAction(scriptId, a.id, { sortOrder: i })
          )
        );
      } catch {
        toast.error('Failed to save order');
      }
    },
    [actions, scriptId, onActionsChange]
  );

  const handleAddAction = async () => {
    try {
      const result = await createAction(scriptId, {
        stepId,
        branchId: branchId || undefined,
        actionType: 'send_message',
        content: '',
        sortOrder: actions.length
      });
      onActionsChange([...actions, result]);
    } catch {
      toast.error('Failed to add action');
    }
  };

  const handleUpdateAction = (updated: ScriptAction) => {
    onActionsChange(actions.map((a) => (a.id === updated.id ? updated : a)));
  };

  const handleDeleteAction = (actionId: string) => {
    onActionsChange(actions.filter((a) => a.id !== actionId));
  };

  return (
    <div className='space-y-2'>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={actions.map((a) => a.id)}
          strategy={verticalListSortingStrategy}
        >
          {actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              scriptId={scriptId}
              forms={forms}
              onUpdate={handleUpdateAction}
              onDelete={handleDeleteAction}
            />
          ))}
        </SortableContext>
      </DndContext>

      <Button
        variant='outline'
        size='sm'
        className='w-full'
        onClick={handleAddAction}
      >
        <Plus className='mr-1 h-3 w-3' />
        Add Action
      </Button>
    </div>
  );
}
