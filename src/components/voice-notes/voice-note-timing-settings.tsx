'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { IconDeviceFloppy } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  getVoiceNoteTimingSettings,
  updateVoiceNoteTimingSettings,
  type VoiceNoteTimingSettings
} from '@/lib/api';

const DEFAULTS: VoiceNoteTimingSettings = {
  minDelay: 10,
  maxDelay: 60
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
    <Card>
      <CardHeader>
        <CardTitle>Voice Note Delay</CardTitle>
        <CardDescription>
          How long the AI waits before sending a voice note reply. A random
          delay between min and max is chosen each time.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-6'>
        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1'>
            <Label htmlFor='minDelay' className='text-sm font-medium'>
              Min Delay (seconds)
            </Label>
            <Input
              id='minDelay'
              type='number'
              step={1}
              min={0}
              max={600}
              value={settings.minDelay}
              onChange={(e) => handleChange('minDelay', e.target.value)}
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='maxDelay' className='text-sm font-medium'>
              Max Delay (seconds)
            </Label>
            <Input
              id='maxDelay'
              type='number'
              step={1}
              min={0}
              max={600}
              value={settings.maxDelay}
              onChange={(e) => handleChange('maxDelay', e.target.value)}
            />
          </div>
        </div>

        <div className='bg-muted/50 rounded-lg border p-4'>
          <p className='text-sm'>
            Each voice note reply will be delayed by a random amount between{' '}
            <span className='font-semibold'>{settings.minDelay}s</span> and{' '}
            <span className='font-semibold'>{settings.maxDelay}s</span>.
          </p>
        </div>

        <Button onClick={handleSave} disabled={saving} className='w-full'>
          <IconDeviceFloppy className='mr-2 h-4 w-4' />
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </CardContent>
    </Card>
  );
}
