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
import BranchCard from './branch-card';
import { createBranch } from '@/lib/api';
import type { ScriptBranch, ScriptForm } from '@/lib/script-types';
import { toast } from 'sonner';

interface BranchListProps {
  branches: ScriptBranch[];
  scriptId: string;
  stepId: string;
  forms: ScriptForm[];
  onBranchesChange: (branches: ScriptBranch[]) => void;
}

export default function BranchList({
  branches,
  scriptId,
  stepId,
  forms,
  onBranchesChange
}: BranchListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = branches.findIndex((b) => b.id === active.id);
      const newIndex = branches.findIndex((b) => b.id === over.id);
      const reordered = arrayMove(branches, oldIndex, newIndex);
      onBranchesChange(reordered);
      // Persist reorder via PUT /branches with branchIds is done at the parent level if needed
    },
    [branches, onBranchesChange]
  );

  const handleAddBranch = async () => {
    try {
      const result = await createBranch(scriptId, stepId, {
        branchLabel: `Branch ${branches.length + 1}`,
        conditionDescription: ''
      });
      onBranchesChange([
        ...branches,
        { ...result, actions: result.actions || [] }
      ]);
    } catch {
      toast.error('Failed to add branch');
    }
  };

  const handleUpdateBranch = (updated: ScriptBranch) => {
    onBranchesChange(branches.map((b) => (b.id === updated.id ? updated : b)));
  };

  const handleDeleteBranch = (branchId: string) => {
    onBranchesChange(branches.filter((b) => b.id !== branchId));
  };

  return (
    <div className='space-y-3'>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={branches.map((b) => b.id)}
          strategy={verticalListSortingStrategy}
        >
          {branches.map((branch) => (
            <BranchCard
              key={branch.id}
              branch={branch}
              scriptId={scriptId}
              stepId={stepId}
              forms={forms}
              onUpdate={handleUpdateBranch}
              onDelete={handleDeleteBranch}
            />
          ))}
        </SortableContext>
      </DndContext>

      <Button variant='outline' size='sm' onClick={handleAddBranch}>
        <Plus className='mr-1 h-3 w-3' />
        Add Branch
      </Button>
    </div>
  );
}
