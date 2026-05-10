'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import BranchList from './branch-list';
import ActionList from './action-list';
import { updateStep } from '@/lib/api';
import type {
  ScriptStep,
  ScriptBranch,
  ScriptAction,
  ScriptForm
} from '@/lib/script-types';
import { toast } from 'sonner';

interface StepDetailProps {
  step: ScriptStep;
  scriptId: string;
  forms: ScriptForm[];
  onStepChange: (step: ScriptStep) => void;
}

export default function StepDetail({
  step,
  scriptId,
  forms,
  onStepChange
}: StepDetailProps) {
  const hasBranches = step.branches.length > 0;
  // Direct actions = actions with no branchId
  const directActions = step.actions.filter((a) => !a.branchId);

  const handleFieldSave = async (field: string, value: string) => {
    try {
      await updateStep(scriptId, step.id, { [field]: value });
      onStepChange({ ...step, [field]: value });
    } catch {
      toast.error('Failed to save');
    }
  };

  const handleBranchesChange = (branches: ScriptBranch[]) => {
    onStepChange({ ...step, branches });
  };

  const handleDirectActionsChange = (actions: ScriptAction[]) => {
    onStepChange({ ...step, actions });
  };

  return (
    <div className='space-y-6'>
      {/* Step Header */}
      <div className='space-y-4'>
        <div className='flex items-center gap-2'>
          <Badge variant='outline' className='shrink-0'>
            Step {step.stepNumber}
          </Badge>
        </div>

        <div className='space-y-3'>
          <div>
            <Label className='text-xs'>Title</Label>
            <Input
              key={`title-${step.id}`}
              defaultValue={step.title}
              placeholder='Step title'
              className='text-lg font-semibold'
              onBlur={(e) => {
                if (e.target.value !== step.title) {
                  handleFieldSave('title', e.target.value);
                }
              }}
            />
          </div>
          <div>
            <Label className='text-xs'>Description</Label>
            <Textarea
              key={`desc-${step.id}`}
              defaultValue={step.description || ''}
              placeholder='What happens at this step?'
              className='text-sm'
              onBlur={(e) => {
                if (e.target.value !== (step.description || '')) {
                  handleFieldSave('description', e.target.value);
                }
              }}
            />
          </div>
          <div>
            <Label className='text-xs'>Objective</Label>
            <Textarea
              key={`obj-${step.id}`}
              defaultValue={step.objective || ''}
              placeholder="What's the goal of this step?"
              className='min-h-[40px] text-sm'
              onBlur={(e) => {
                if (e.target.value !== (step.objective || '')) {
                  handleFieldSave('objective', e.target.value);
                }
              }}
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Direct actions (when present) — actions on this step that
          don't belong to any branch. Always rendered when the step
          has any, even if branches also exist, so the operator can
          see + edit + delete them. */}
      {directActions.length > 0 && (
        <div className='space-y-3'>
          <Label className='text-sm font-medium'>
            {hasBranches ? 'Direct Actions (no branch)' : 'Actions'}
          </Label>
          <ActionList
            actions={directActions}
            scriptId={scriptId}
            stepId={step.id}
            forms={forms}
            onActionsChange={handleDirectActionsChange}
          />
        </div>
      )}

      {/* Branches — always rendered with Add Branch button so every
          step can have branches added regardless of whether it
          currently has direct actions or no actions yet. (Bug-fix
          2026-05-09: previously the component rendered Branches OR
          Actions, never both — steps without branches couldn't have
          a branch added because the BranchList component never
          mounted.) */}
      <div className='space-y-3'>
        <Label className='text-sm font-medium'>Branches</Label>
        <BranchList
          branches={step.branches}
          scriptId={scriptId}
          stepId={step.id}
          forms={forms}
          onBranchesChange={handleBranchesChange}
        />
      </div>

      {/* Empty state for new steps with neither branches nor direct
          actions. Surface the choice explicitly so operators don't
          have to guess. */}
      {!hasBranches && directActions.length === 0 && (
        <div className='border-muted-foreground/30 rounded-md border border-dashed p-4 text-center'>
          <p className='text-muted-foreground text-sm'>
            This step has no actions or branches yet.
          </p>
          <p className='text-muted-foreground mt-1 text-xs'>
            Add a Branch above for conditional flow, or add direct Actions
            below.
          </p>
          <div className='mt-3'>
            <Label className='text-sm font-medium'>Direct Actions</Label>
            <div className='mt-2'>
              <ActionList
                actions={directActions}
                scriptId={scriptId}
                stepId={step.id}
                forms={forms}
                onActionsChange={handleDirectActionsChange}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
