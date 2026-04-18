'use client';

import { useState, useEffect, useCallback } from 'react';
import { Switch } from '@/components/ui/switch';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import { IconMoon, IconMoonOff, IconBrandInstagram } from '@tabler/icons-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface AwayModeState {
  awayModeInstagram: boolean;
  awayModeInstagramEnabledAt: string | null;
  awayModeFacebook: boolean;
  awayModeFacebookEnabledAt: string | null;
  // Derived legacy field for any consumer that hasn't migrated yet.
  awayMode: boolean;
  awayModeEnabledAt: string | null;
}

const DEFAULT_STATE: AwayModeState = {
  awayModeInstagram: false,
  awayModeInstagramEnabledAt: null,
  awayModeFacebook: false,
  awayModeFacebookEnabledAt: null,
  awayMode: false,
  awayModeEnabledAt: null
};

export function AwayModeToggle() {
  const [state, setState] = useState<AwayModeState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);
  const [togglingIg, setTogglingIg] = useState(false);
  const [togglingFb, setTogglingFb] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiFetch<AwayModeState>('/settings/away-mode');
      setState(data);
    } catch {
      // Silently fail — user may not be authenticated yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const togglePlatform = async (
    platform: 'instagram' | 'facebook',
    checked: boolean
  ) => {
    const setToggling =
      platform === 'instagram' ? setTogglingIg : setTogglingFb;
    const field =
      platform === 'instagram' ? 'awayModeInstagram' : 'awayModeFacebook';
    setToggling(true);
    try {
      const data = await apiFetch<AwayModeState>('/settings/away-mode', {
        method: 'PUT',
        body: JSON.stringify({ [field]: checked })
      });
      setState(data);
      toast.success(
        `${platform === 'instagram' ? 'Instagram' : 'Facebook'} AI ${
          checked
            ? 'ON — auto-responding to new leads'
            : 'OFF — all new leads go to human-only until you turn it back on'
        }`
      );
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 403) {
        toast.error('Only admins can toggle Away Mode');
      } else {
        toast.error('Failed to toggle Away Mode');
      }
    } finally {
      setToggling(false);
    }
  };

  if (loading) return null;

  const anyOn = state.awayModeInstagram || state.awayModeFacebook;
  const bothOn = state.awayModeInstagram && state.awayModeFacebook;
  const summary = bothOn
    ? 'ON for both platforms'
    : state.awayModeInstagram
      ? 'ON for Instagram'
      : state.awayModeFacebook
        ? 'ON for Facebook'
        : 'OFF';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Toggle Away Mode'
          title={`Away Mode — ${summary}`}
          className={cn(
            'hover:bg-accent flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors',
            anyOn && 'bg-indigo-50 dark:bg-indigo-950/30'
          )}
        >
          {anyOn ? (
            <IconMoon className='h-4 w-4 text-indigo-500' />
          ) : (
            <IconMoonOff className='text-muted-foreground h-4 w-4' />
          )}
          {anyOn && (
            <span className='text-[10px] font-medium text-indigo-600 dark:text-indigo-400'>
              {bothOn ? 'IG+FB' : state.awayModeInstagram ? 'IG' : 'FB'}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-72' align='end'>
        <div className='space-y-3'>
          <div>
            <h4 className='text-sm font-semibold'>Platform AI</h4>
            <p className='text-muted-foreground text-xs'>
              Master switch for AI auto-send on each platform. When OFF, the AI
              generates suggestions but does not send — nothing ships to the
              platform even if individual chats have AI on. Turn ON when you
              want AI to auto-respond to new leads.
            </p>
          </div>

          <div className='space-y-2'>
            {/* Instagram */}
            <div className='flex items-center justify-between gap-3 rounded-md border p-3'>
              <div className='flex min-w-0 items-center gap-2'>
                <IconBrandInstagram className='h-4 w-4 shrink-0 text-pink-500' />
                <div className='min-w-0'>
                  <div className='text-sm font-medium'>Instagram</div>
                  {state.awayModeInstagram &&
                    state.awayModeInstagramEnabledAt && (
                      <div className='text-muted-foreground text-[10px]'>
                        Since{' '}
                        {new Date(
                          state.awayModeInstagramEnabledAt
                        ).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </div>
                    )}
                </div>
              </div>
              <Switch
                checked={state.awayModeInstagram}
                onCheckedChange={(v) => togglePlatform('instagram', v)}
                disabled={togglingIg}
                className='data-[state=checked]:bg-indigo-500'
              />
            </div>

            {/* Facebook */}
            <div className='flex items-center justify-between gap-3 rounded-md border p-3'>
              <div className='flex min-w-0 items-center gap-2'>
                <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white'>
                  f
                </span>
                <div className='min-w-0'>
                  <div className='text-sm font-medium'>Facebook</div>
                  {state.awayModeFacebook &&
                    state.awayModeFacebookEnabledAt && (
                      <div className='text-muted-foreground text-[10px]'>
                        Since{' '}
                        {new Date(
                          state.awayModeFacebookEnabledAt
                        ).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </div>
                    )}
                </div>
              </div>
              <Switch
                checked={state.awayModeFacebook}
                onCheckedChange={(v) => togglePlatform('facebook', v)}
                disabled={togglingFb}
                className='data-[state=checked]:bg-indigo-500'
              />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
