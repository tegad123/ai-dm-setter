'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { IconInfoCircle, IconDeviceFloppy } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  getVoiceNoteTimingSettings,
  updateVoiceNoteTimingSettings,
  type VoiceNoteTimingSettings
} from '@/lib/api';

const DEFAULTS: VoiceNoteTimingSettings = {
  recordingSpeedMin: 0.7,
  recordingSpeedMax: 1.0,
  thinkingBufferMin: 3,
  thinkingBufferMax: 8
};

export default function VoiceNoteTimingSettingsPanel() {
  const [settings, setSettings] = useState<VoiceNoteTimingSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getVoiceNoteTimingSettings()
      .then(setSettings)
      .catch(() => toast.error('Failed to load timing settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = useCallback(
    (field: keyof VoiceNoteTimingSettings, value: string) => {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        setSettings((prev) => ({ ...prev, [field]: num }));
      }
    },
    []
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const updated = await updateVoiceNoteTimingSettings(settings);
      setSettings(updated);
      toast.success('Timing settings saved');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to save settings'
      );
    } finally {
      setSaving(false);
    }
  }, [settings]);

  // Live preview: for a 60-second voice note
  const preview = useMemo(() => {
    const min = Math.round(
      60 * settings.recordingSpeedMin + settings.thinkingBufferMin
    );
    const max = Math.round(
      60 * settings.recordingSpeedMax + settings.thinkingBufferMax
    );
    return { min: Math.max(10, min), max: Math.min(180, max) };
  }, [settings]);

  if (loading) {
    return (
      <Card>
        <CardContent className='flex items-center justify-center py-12'>
          <p className='text-muted-foreground text-sm'>
            Loading timing settings...
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <CardTitle>Recording Simulation</CardTitle>
          <CardDescription>
            When the AI sends a voice note, it waits a calculated amount of time
            to simulate natural recording behavior. The delay is based on the
            voice note&apos;s actual duration.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-6'>
          {/* Recording Speed */}
          <div className='space-y-3'>
            <div className='flex items-center gap-2'>
              <Label className='text-sm font-medium'>
                Recording Speed (multiplier)
              </Label>
              <HelpTooltip text="Controls how long the AI 'takes' to record a voice note before sending it. 1.0 means the AI waits the full duration of the voice note. 0.7 means the AI waits 70% of the voice note's duration. The actual wait randomizes between min and max for each voice note sent." />
            </div>
            <div className='grid grid-cols-2 gap-4'>
              <div className='space-y-1'>
                <Label
                  htmlFor='speedMin'
                  className='text-muted-foreground text-xs'
                >
                  Min
                </Label>
                <Input
                  id='speedMin'
                  type='number'
                  step={0.1}
                  min={0.1}
                  max={2.0}
                  value={settings.recordingSpeedMin}
                  onChange={(e) =>
                    handleChange('recordingSpeedMin', e.target.value)
                  }
                />
              </div>
              <div className='space-y-1'>
                <Label
                  htmlFor='speedMax'
                  className='text-muted-foreground text-xs'
                >
                  Max
                </Label>
                <Input
                  id='speedMax'
                  type='number'
                  step={0.1}
                  min={0.1}
                  max={2.0}
                  value={settings.recordingSpeedMax}
                  onChange={(e) =>
                    handleChange('recordingSpeedMax', e.target.value)
                  }
                />
              </div>
            </div>
          </div>

          {/* Thinking Buffer */}
          <div className='space-y-3'>
            <div className='flex items-center gap-2'>
              <Label className='text-sm font-medium'>
                Thinking Buffer (seconds)
              </Label>
              <HelpTooltip text='An extra delay added before the recording simulation starts, simulating the time a human takes to decide to record. Randomized between min and max for each voice note sent.' />
            </div>
            <div className='grid grid-cols-2 gap-4'>
              <div className='space-y-1'>
                <Label
                  htmlFor='thinkingMin'
                  className='text-muted-foreground text-xs'
                >
                  Min
                </Label>
                <Input
                  id='thinkingMin'
                  type='number'
                  step={1}
                  min={0}
                  max={30}
                  value={settings.thinkingBufferMin}
                  onChange={(e) =>
                    handleChange('thinkingBufferMin', e.target.value)
                  }
                />
              </div>
              <div className='space-y-1'>
                <Label
                  htmlFor='thinkingMax'
                  className='text-muted-foreground text-xs'
                >
                  Max
                </Label>
                <Input
                  id='thinkingMax'
                  type='number'
                  step={1}
                  min={0}
                  max={30}
                  value={settings.thinkingBufferMax}
                  onChange={(e) =>
                    handleChange('thinkingBufferMax', e.target.value)
                  }
                />
              </div>
            </div>
          </div>

          {/* Live Preview */}
          <div className='bg-muted/50 rounded-lg border p-4'>
            <p className='text-sm'>
              <span className='font-medium'>Preview:</span> For a 60-second
              voice note, the AI will wait between{' '}
              <span className='font-semibold'>{preview.min}s</span> and{' '}
              <span className='font-semibold'>{preview.max}s</span> before
              sending it.
            </p>
            <p className='text-muted-foreground mt-1 text-xs'>
              Minimum floor: 10s. Maximum ceiling: 180s. These limits apply
              regardless of settings.
            </p>
          </div>

          {/* Save */}
          <Button onClick={handleSave} disabled={saving} className='w-full'>
            <IconDeviceFloppy className='mr-2 h-4 w-4' />
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

function HelpTooltip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconInfoCircle className='text-muted-foreground h-4 w-4 cursor-help' />
      </TooltipTrigger>
      <TooltipContent side='right' className='max-w-xs'>
        <p className='text-xs'>{text}</p>
      </TooltipContent>
    </Tooltip>
  );
}
