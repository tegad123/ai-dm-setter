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

      {/* Branches or Direct Actions */}
      <div className='space-y-3'>
        <Label className='text-sm font-medium'>
          {hasBranches ? 'Branches' : 'Actions'}
        </Label>

        {hasBranches ? (
          <BranchList
            branches={step.branches}
            scriptId={scriptId}
            stepId={step.id}
            forms={forms}
            onBranchesChange={handleBranchesChange}
          />
        ) : (
          <ActionList
            actions={directActions}
            scriptId={scriptId}
            stepId={step.id}
            forms={forms}
            onActionsChange={handleDirectActionsChange}
          />
        )}
      </div>
    </div>
  );
}
