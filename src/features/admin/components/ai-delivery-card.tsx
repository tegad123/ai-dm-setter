'use client';

// Platform-operator kill switch for a tenant's AI delivery, per platform.
// "Live" = the AI delivers its replies. "Suggestions only" = everything
// still generates and is stored (with shadow rows), nothing is delivered.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

export interface AiDeliveryState {
  id: string;
  name: string;
  generateOnlyInstagram: boolean;
  generateOnlyFacebook: boolean;
  awayModeInstagram: boolean;
  awayModeFacebook: boolean;
  showSuggestionBanner: boolean;
}

type Platform = 'INSTAGRAM' | 'FACEBOOK';

export function AiDeliveryCard({
  accountId,
  compact = false,
  onChange
}: {
  accountId: string;
  compact?: boolean;
  onChange?: (s: AiDeliveryState) => void;
}) {
  const [state, setState] = useState<AiDeliveryState | null>(null);
  const [busy, setBusy] = useState<Platform | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await apiFetch<AiDeliveryState>(
        `/admin/accounts/${accountId}/ai-delivery`
      );
      setState(s);
      onChange?.(s);
    } catch (err) {
      toast.error(
        `Could not load AI delivery state: ${(err as Error).message}`
      );
    }
  }, [accountId, onChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const setLive = async (platform: Platform, live: boolean) => {
    const field =
      platform === 'INSTAGRAM'
        ? 'generateOnlyInstagram'
        : 'generateOnlyFacebook';
    const label = platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook';
    if (!live) {
      const ok = window.confirm(
        `Stop AI delivery on ${label}? Drafts keep generating as suggestions; nothing is sent to leads until you turn it back on.`
      );
      if (!ok) return;
    } else {
      const ok = window.confirm(
        `Turn AI delivery ON for ${label}? The AI will send replies to leads on ${label} at full volume.`
      );
      if (!ok) return;
    }
    setBusy(platform);
    try {
      const s = await apiFetch<AiDeliveryState>(
        `/admin/accounts/${accountId}/ai-delivery`,
        {
          method: 'PUT',
          body: JSON.stringify({ [field]: !live })
        }
      );
      setState(s);
      onChange?.(s);
      toast.success(
        `${label}: ${live ? 'AI delivery ON, sending live' : 'AI delivery STOPPED, suggestions only'}`
      );
    } catch (err) {
      toast.error(`Update failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const row = (platform: Platform) => {
    if (!state) return null;
    const genOnly =
      platform === 'INSTAGRAM'
        ? state.generateOnlyInstagram
        : state.generateOnlyFacebook;
    const away =
      platform === 'INSTAGRAM'
        ? state.awayModeInstagram
        : state.awayModeFacebook;
    const live = !genOnly;
    return (
      <div
        key={platform}
        className='flex items-center justify-between gap-4 rounded-md border p-3'
      >
        <div className='space-y-1'>
          <div className='flex items-center gap-2'>
            <span className='font-medium'>
              {platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'}
            </span>
            {live ? (
              <Badge className='bg-emerald-600 text-white'>LIVE</Badge>
            ) : (
              <Badge variant='secondary'>SUGGESTIONS ONLY</Badge>
            )}
            {!away && <Badge variant='outline'>away mode off</Badge>}
          </div>
          {!compact && (
            <p className='text-xs text-zinc-500'>
              {live
                ? 'The AI delivers its replies to leads. Flip off to stop every send instantly; drafts keep generating as suggestions.'
                : 'Nothing is delivered. Every draft is stored as a suggestion with its gate verdict.'}
            </p>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <span className='text-xs text-zinc-500'>
            {live ? 'Live' : 'Stopped'}
          </span>
          <Switch
            checked={live}
            disabled={busy === platform}
            onCheckedChange={(v) => void setLive(platform, v)}
          />
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>AI delivery (kill switch)</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        {state ? (
          <>
            {row('INSTAGRAM')}
            {row('FACEBOOK')}
          </>
        ) : (
          <p className='text-sm text-zinc-500'>Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}
