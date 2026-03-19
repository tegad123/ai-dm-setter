'use client';

import { useState, useEffect, useCallback } from 'react';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { IconMoon, IconMoonOff } from '@tabler/icons-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface AwayModeState {
  awayMode: boolean;
  awayModeEnabledAt: string | null;
}

export function AwayModeToggle() {
  const [state, setState] = useState<AwayModeState>({
    awayMode: false,
    awayModeEnabledAt: null
  });
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

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

  const handleToggle = async (checked: boolean) => {
    setToggling(true);
    try {
      const data = await apiFetch<AwayModeState>('/settings/away-mode', {
        method: 'PUT',
        body: JSON.stringify({ awayMode: checked })
      });
      setState(data);
      toast.success(
        checked
          ? 'Away Mode ON — AI is handling all conversations'
          : 'Away Mode OFF — team is back in control'
      );
    } catch (err: any) {
      if (err.status === 403) {
        toast.error('Only admins can toggle Away Mode');
      } else {
        toast.error('Failed to toggle Away Mode');
      }
    } finally {
      setToggling(false);
    }
  };

  if (loading) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className='flex items-center gap-1.5'>
            {state.awayMode ? (
              <IconMoon className='h-4 w-4 text-indigo-500' />
            ) : (
              <IconMoonOff className='text-muted-foreground h-4 w-4' />
            )}
            <Switch
              checked={state.awayMode}
              onCheckedChange={handleToggle}
              disabled={toggling}
              className={cn(
                'h-5 w-9',
                state.awayMode && 'data-[state=checked]:bg-indigo-500'
              )}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className='text-xs'>
            {state.awayMode
              ? 'Away Mode ON — AI handles all conversations'
              : 'Away Mode OFF — click to let AI handle everything'}
          </p>
          {state.awayMode && state.awayModeEnabledAt && (
            <p className='text-muted-foreground text-[10px]'>
              Since{' '}
              {new Date(state.awayModeEnabledAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit'
              })}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
