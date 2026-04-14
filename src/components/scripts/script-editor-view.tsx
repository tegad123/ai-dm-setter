'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Loader2, Check, FileText, ListChecks } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import StepSidebar from './step-sidebar';
import StepDetail from './step-detail';
import FormManager from './form-manager';
import ParseSummaryBanner from './parse-summary-banner';
import ReuploadScriptDialog from './reupload-script-dialog';
import { fetchScript, updateScript, activateScript } from '@/lib/api';
import type { Script, ScriptStep, ScriptForm } from '@/lib/script-types';
import { toast } from 'sonner';

interface ScriptEditorViewProps {
  scriptId: string;
}

export default function ScriptEditorView({ scriptId }: ScriptEditorViewProps) {
  const router = useRouter();
  const [script, setScript] = useState<Script | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [reuploadOpen, setReuploadOpen] = useState(false);
  const [viewTab, setViewTab] = useState<'steps' | 'forms'>('steps');

  const load = useCallback(async () => {
    try {
      const data = await fetchScript(scriptId);
      setScript(data);
      if (!activeStepId && data.steps.length > 0) {
        setActiveStepId(data.steps[0].id);
      }
    } catch (err) {
      console.error('Failed to load script:', err);
      toast.error('Failed to load script');
    } finally {
      setLoading(false);
    }
  }, [scriptId, activeStepId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleNameSave = async (name: string) => {
    if (!script || name === script.name) return;
    try {
      await updateScript(scriptId, { name });
      setScript({ ...script, name });
    } catch {
      toast.error('Failed to save name');
    }
  };

  const handleToggleActive = async () => {
    if (!script) return;
    try {
      await activateScript(scriptId);
      setScript({ ...script, isActive: true });
      toast.success('Script activated');
    } catch {
      toast.error('Failed to activate script');
    }
  };

  const handleStepsChange = (steps: ScriptStep[]) => {
    if (!script) return;
    setScript({ ...script, steps });
  };

  const handleStepChange = (updatedStep: ScriptStep) => {
    if (!script) return;
    setScript({
      ...script,
      steps: script.steps.map((s) =>
        s.id === updatedStep.id ? updatedStep : s
      )
    });
  };

  const handleFormsChange = (forms: ScriptForm[]) => {
    if (!script) return;
    setScript({ ...script, forms });
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center py-20'>
        <Loader2 className='text-muted-foreground h-6 w-6 animate-spin' />
      </div>
    );
  }

  if (!script) {
    return (
      <div className='py-20 text-center'>
        <p className='text-muted-foreground'>Script not found.</p>
        <Button
          variant='link'
          onClick={() => router.push('/dashboard/settings/persona')}
        >
          Back to scripts
        </Button>
      </div>
    );
  }

  const activeStep = script.steps.find((s) => s.id === activeStepId) || null;

  return (
    <div className='flex h-[calc(100vh-4rem)] flex-col'>
      {/* Top bar */}
      <div className='border-border flex items-center gap-3 border-b px-4 py-3'>
        <Button
          variant='ghost'
          size='icon'
          onClick={() => router.push('/dashboard/settings/persona')}
        >
          <ArrowLeft className='h-4 w-4' />
        </Button>

        <Input
          defaultValue={script.name}
          className='max-w-sm border-none px-0 text-lg font-semibold shadow-none focus-visible:ring-0'
          onBlur={(e) => handleNameSave(e.target.value)}
        />

        {script.isDefault && (
          <Badge variant='secondary'>Default Template</Badge>
        )}

        <div className='ml-auto flex items-center gap-3'>
          <div className='flex items-center gap-2'>
            <span className='text-muted-foreground text-sm'>
              {script.isActive ? 'Active' : 'Inactive'}
            </span>
            <Switch
              checked={script.isActive}
              onCheckedChange={handleToggleActive}
            />
          </div>
          {script.isActive && (
            <Badge variant='default'>
              <Check className='mr-1 h-3 w-3' />
              Active
            </Badge>
          )}
        </div>
      </div>

      {/* Parse summary banner (only for parsed scripts) */}
      {script.createdVia === 'upload_parsed' && (
        <ParseSummaryBanner
          script={script}
          onReupload={() => setReuploadOpen(true)}
        />
      )}

      {/* Tab bar: Steps / Forms */}
      <div className='border-border border-b px-4'>
        <Tabs
          value={viewTab}
          onValueChange={(v) => setViewTab(v as 'steps' | 'forms')}
        >
          <TabsList className='h-10 bg-transparent p-0'>
            <TabsTrigger
              value='steps'
              className='data-[state=active]:border-primary rounded-none border-b-2 border-transparent px-4 data-[state=active]:shadow-none'
            >
              <ListChecks className='mr-1.5 h-4 w-4' />
              Steps ({script.steps.length})
            </TabsTrigger>
            <TabsTrigger
              value='forms'
              className='data-[state=active]:border-primary rounded-none border-b-2 border-transparent px-4 data-[state=active]:shadow-none'
            >
              <FileText className='mr-1.5 h-4 w-4' />
              Reference Data ({script.forms.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Main content */}
      {viewTab === 'steps' && (
        <div className='flex flex-1 overflow-hidden'>
          {/* Left sidebar */}
          <div className='border-border w-64 shrink-0 overflow-y-auto border-r py-3'>
            <StepSidebar
              steps={script.steps}
              scriptId={scriptId}
              activeStepId={activeStepId}
              onSelectStep={setActiveStepId}
              onStepsChange={handleStepsChange}
            />
          </div>

          {/* Right detail area */}
          <div className='flex-1 overflow-y-auto p-6'>
            {activeStep ? (
              <StepDetail
                key={activeStep.id}
                step={activeStep}
                scriptId={scriptId}
                forms={script.forms}
                onStepChange={handleStepChange}
              />
            ) : (
              <div className='flex h-full items-center justify-center'>
                <p className='text-muted-foreground'>
                  Select a step from the sidebar to edit it.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {viewTab === 'forms' && (
        <div className='flex-1 overflow-y-auto p-6'>
          <div className='mx-auto max-w-2xl'>
            <div className='mb-4'>
              <h2 className='text-lg font-semibold'>Reference Data & Forms</h2>
              <p className='text-muted-foreground text-sm'>
                Forms are available to the AI throughout the entire conversation
                — not tied to any specific step. Use them for FAQs, pricing
                data, qualification criteria, and other reference material.
              </p>
            </div>
            <FormManager
              forms={script.forms}
              scriptId={scriptId}
              onFormsChange={handleFormsChange}
            />
          </div>
        </div>
      )}

      {/* Re-upload dialog */}
      {script.createdVia === 'upload_parsed' && (
        <ReuploadScriptDialog
          scriptId={scriptId}
          open={reuploadOpen}
          onOpenChange={setReuploadOpen}
          onComplete={() => load()}
        />
      )}
    </div>
  );
}
