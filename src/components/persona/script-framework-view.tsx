'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent
} from '@/components/ui/collapsible';
import { toast } from 'sonner';
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Save,
  X,
  MessageSquare,
  Mic,
  Link2,
  Video,
  HelpCircle,
  Clock,
  Bell,
  GitBranch
} from 'lucide-react';
import type { ScriptStep, ScriptAction } from '@/lib/script-framework-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoiceNoteSlotRef {
  id: string;
  slotName: string;
  status: string;
}

interface ScriptFrameworkViewProps {
  breakdownId: string;
  scriptSteps: ScriptStep[];
  voiceNoteSlots: VoiceNoteSlotRef[];
  onStepsChange: (steps: ScriptStep[]) => void;
  onSwitchToVoiceNotes?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_ICONS: Record<string, React.ReactNode> = {
  send_message: <MessageSquare className='h-3.5 w-3.5 text-blue-600' />,
  send_voice_note: <Mic className='h-3.5 w-3.5 text-purple-600' />,
  send_link: <Link2 className='h-3.5 w-3.5 text-cyan-600' />,
  send_video: <Video className='h-3.5 w-3.5 text-pink-600' />,
  ask_question: <HelpCircle className='h-3.5 w-3.5 text-amber-600' />,
  wait_for_response: <Clock className='h-3.5 w-3.5 text-gray-500' />,
  trigger_followup: <Bell className='h-3.5 w-3.5 text-orange-600' />,
  branch_decision: <GitBranch className='h-3.5 w-3.5 text-indigo-600' />
};

function actionLabel(type: string): string {
  switch (type) {
    case 'send_message':
      return 'Send message';
    case 'send_voice_note':
      return 'Send voice note';
    case 'send_link':
      return 'Send link';
    case 'send_video':
      return 'Send video';
    case 'ask_question':
      return 'Ask question';
    case 'wait_for_response':
      return 'Wait for response';
    case 'trigger_followup':
      return 'Trigger follow-up';
    case 'branch_decision':
      return 'Branch decision';
    default:
      return type;
  }
}

function slotStatusBadge(status: string) {
  if (status === 'APPROVED')
    return (
      <Badge className='border-green-300 bg-green-100 text-xs text-green-800'>
        Audio ready
      </Badge>
    );
  if (status === 'UPLOADED')
    return (
      <Badge className='border-amber-300 bg-amber-100 text-xs text-amber-800'>
        Uploaded
      </Badge>
    );
  return (
    <Badge className='border-red-300 bg-red-100 text-xs text-red-800'>
      No audio
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScriptFrameworkView({
  breakdownId,
  scriptSteps,
  voiceNoteSlots,
  onStepsChange,
  onSwitchToVoiceNotes
}: ScriptFrameworkViewProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editActionContent, setEditActionContent] = useState<
    Record<string, string>
  >({});
  const [saving, setSaving] = useState(false);

  // Toggle step expansion
  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  // Start editing a step
  const startEditing = (step: ScriptStep) => {
    setEditingStepId(step.step_id);
    setEditTitle(step.title);
    const contentMap: Record<string, string> = {};
    for (const branch of step.branches) {
      for (const action of branch.actions) {
        contentMap[action.action_id] = action.content || '';
      }
    }
    setEditActionContent(contentMap);
  };

  // Save step edits
  const saveStep = async (step: ScriptStep) => {
    setSaving(true);
    try {
      const updatedBranches = step.branches.map((branch) => ({
        ...branch,
        actions: branch.actions.map((action) => ({
          ...action,
          content:
            editActionContent[action.action_id] !== undefined
              ? editActionContent[action.action_id]
              : action.content
        }))
      }));

      await apiFetch(`/settings/persona/script/${breakdownId}/step`, {
        method: 'PUT',
        body: JSON.stringify({
          stepId: step.step_id,
          title: editTitle,
          branches: updatedBranches
        })
      });

      // Update local state
      const updated = scriptSteps.map((s) =>
        s.step_id === step.step_id
          ? {
              ...s,
              title: editTitle,
              branches: updatedBranches,
              user_edited: true
            }
          : s
      );
      onStepsChange(updated);
      setEditingStepId(null);
      toast.success('Step updated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  // Toggle step approval
  const toggleApproval = async (step: ScriptStep) => {
    const newApproval = !step.user_approved;
    try {
      await apiFetch(`/settings/persona/script/${breakdownId}/step`, {
        method: 'PUT',
        body: JSON.stringify({
          stepId: step.step_id,
          userApproved: newApproval
        })
      });
      const updated = scriptSteps.map((s) =>
        s.step_id === step.step_id ? { ...s, user_approved: newApproval } : s
      );
      onStepsChange(updated);
    } catch {
      toast.error('Failed to update approval');
    }
  };

  // Find slot info
  const getSlotInfo = (slotId: string | null): VoiceNoteSlotRef | undefined => {
    if (!slotId) return undefined;
    return voiceNoteSlots.find((s) => s.id === slotId);
  };

  // Empty state
  if (!scriptSteps || scriptSteps.length === 0) {
    return (
      <Card>
        <CardContent className='py-8 text-center'>
          <GitBranch className='text-muted-foreground mx-auto mb-3 h-8 w-8' />
          <p className='text-muted-foreground'>
            No script steps generated yet. Upload a sales script to generate the
            sequential flow.
          </p>
        </CardContent>
      </Card>
    );
  }

  const approvedCount = scriptSteps.filter((s) => s.user_approved).length;

  return (
    <div className='space-y-3'>
      {/* Summary bar */}
      <Card>
        <CardContent className='flex flex-wrap items-center gap-4 py-3'>
          <span className='text-sm font-medium'>
            {scriptSteps.length} step{scriptSteps.length !== 1 ? 's' : ''}
          </span>
          <span className='text-muted-foreground text-sm'>
            {approvedCount} approved
          </span>
          <Button
            variant='ghost'
            size='sm'
            className='ml-auto text-xs'
            onClick={() => {
              const allExpanded = scriptSteps.every((s) =>
                expandedSteps.has(s.step_id)
              );
              if (allExpanded) {
                setExpandedSteps(new Set());
              } else {
                setExpandedSteps(new Set(scriptSteps.map((s) => s.step_id)));
              }
            }}
          >
            {scriptSteps.every((s) => expandedSteps.has(s.step_id))
              ? 'Collapse All'
              : 'Expand All'}
          </Button>
        </CardContent>
      </Card>

      {/* Step cards */}
      {scriptSteps.map((step) => {
        const isExpanded = expandedSteps.has(step.step_id);
        const isEditing = editingStepId === step.step_id;

        return (
          <Card
            key={step.step_id}
            className={
              step.user_approved ? 'border-l-4 border-l-green-500' : ''
            }
          >
            <Collapsible
              open={isExpanded}
              onOpenChange={() => toggleStep(step.step_id)}
            >
              <CardHeader className='py-3'>
                <div className='flex items-center gap-3'>
                  {/* Step number */}
                  <Badge
                    variant='outline'
                    className='h-7 w-7 shrink-0 justify-center rounded-full p-0 text-xs font-bold'
                  >
                    {step.step_number}
                  </Badge>

                  {/* Title */}
                  <CollapsibleTrigger asChild>
                    <button className='flex flex-1 items-center gap-2 text-left'>
                      {isEditing ? (
                        <Input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className='h-8 text-sm font-semibold'
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <CardTitle className='text-sm font-semibold'>
                          {step.title}
                        </CardTitle>
                      )}
                      {isExpanded ? (
                        <ChevronDown className='text-muted-foreground h-4 w-4 shrink-0' />
                      ) : (
                        <ChevronRight className='text-muted-foreground h-4 w-4 shrink-0' />
                      )}
                    </button>
                  </CollapsibleTrigger>

                  {/* Badges */}
                  {step.user_edited && (
                    <Badge variant='secondary' className='text-xs'>
                      Edited
                    </Badge>
                  )}

                  {/* Edit/Save buttons */}
                  {isEditing ? (
                    <div className='flex gap-1'>
                      <Button
                        size='sm'
                        variant='ghost'
                        disabled={saving}
                        onClick={() => saveStep(step)}
                      >
                        {saving ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        ) : (
                          <Save className='h-3.5 w-3.5' />
                        )}
                      </Button>
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => setEditingStepId(null)}
                      >
                        <X className='h-3.5 w-3.5' />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => startEditing(step)}
                    >
                      <Pencil className='h-3.5 w-3.5' />
                    </Button>
                  )}

                  {/* Approve checkbox */}
                  <Checkbox
                    checked={step.user_approved}
                    onCheckedChange={() => toggleApproval(step)}
                    aria-label='Approve step'
                  />
                </div>
              </CardHeader>

              <CollapsibleContent>
                <CardContent className='space-y-3 pt-0'>
                  {step.branches.map((branch) => (
                    <div key={branch.branch_id} className='space-y-2'>
                      {/* Branch condition */}
                      {branch.condition !== 'default' && (
                        <div className='flex items-center gap-2 text-xs'>
                          <GitBranch className='h-3 w-3 text-indigo-500' />
                          <span className='font-medium text-indigo-700'>
                            IF: {branch.condition}
                          </span>
                        </div>
                      )}

                      {/* Actions */}
                      <div className='space-y-1.5 pl-2'>
                        {branch.actions.map((action: ScriptAction) => {
                          const slotInfo = getSlotInfo(
                            action.voice_note_slot_id
                          );

                          return (
                            <div
                              key={action.action_id}
                              className={`flex items-start gap-2 rounded-md border p-2 text-sm ${
                                action.action_type === 'send_voice_note'
                                  ? 'border-purple-200 bg-purple-50/50'
                                  : 'bg-muted/30'
                              }`}
                            >
                              {/* Icon */}
                              <span className='mt-0.5'>
                                {ACTION_ICONS[action.action_type] || (
                                  <MessageSquare className='h-3.5 w-3.5' />
                                )}
                              </span>

                              {/* Content */}
                              <div className='flex-1 space-y-1'>
                                <span className='text-muted-foreground text-xs font-medium'>
                                  {actionLabel(action.action_type)}
                                </span>

                                {isEditing &&
                                action.action_type !== 'wait_for_response' ? (
                                  <Textarea
                                    value={
                                      editActionContent[action.action_id] ?? ''
                                    }
                                    onChange={(e) =>
                                      setEditActionContent((prev) => ({
                                        ...prev,
                                        [action.action_id]: e.target.value
                                      }))
                                    }
                                    className='mt-1 min-h-[60px] text-xs'
                                  />
                                ) : action.content ? (
                                  <p className='text-xs whitespace-pre-wrap'>
                                    {action.content}
                                  </p>
                                ) : null}

                                {/* Voice note slot reference */}
                                {slotInfo && (
                                  <div className='mt-1 flex items-center gap-2'>
                                    {slotStatusBadge(slotInfo.status)}
                                    <span className='text-xs text-purple-700'>
                                      {slotInfo.slotName}
                                    </span>
                                    {onSwitchToVoiceNotes && (
                                      <Button
                                        variant='link'
                                        size='sm'
                                        className='h-auto p-0 text-xs text-purple-600'
                                        onClick={onSwitchToVoiceNotes}
                                      >
                                        Manage
                                      </Button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        );
      })}
    </div>
  );
}
