'use client';

// /admin/live-feed — platform-operator view of every AI message DELIVERED to
// a lead on one account + platform, newest first, auto-refreshing, with the
// egress gate verdict on each bubble and the gate holds in the same window.
// The kill switch for the same account sits at the top of the page.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AiDeliveryCard } from '@/features/admin/components/ai-delivery-card';

interface AccountRow {
  id: string;
  name: string;
}
interface FeedItem {
  id: string;
  conversationId: string;
  leadName: string | null;
  step: number | null;
  content: string;
  deliveredAt: string;
  platformMessageId: string | null;
  gate: { allow: boolean; reason: string | null; sendPath: string } | null;
}
interface HoldItem {
  conversationId: string | null;
  leadName: string | null;
  at: string;
  reason: string | null;
  sendPath: string;
  draft: string | null;
}
interface FeedResponse {
  account: { id: string; name: string; generateOnly: boolean };
  platform: 'INSTAGRAM' | 'FACEBOOK';
  since: string;
  generatedAt: string;
  deliveredCount: number;
  holdCount: number;
  delivered: FeedItem[];
  holds: HoldItem[];
}

const REFRESH_MS = 10_000;
const fmt = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

export default function AdminLiveFeedPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountId, setAccountId] = useState<string>('');
  const [platform, setPlatform] = useState<'INSTAGRAM' | 'FACEBOOK'>(
    'INSTAGRAM'
  );
  const [windowMin, setWindowMin] = useState<number>(1440);
  const [data, setData] = useState<FeedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  const lastTopId = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch<{ accounts?: AccountRow[] } | AccountRow[]>(
          '/admin/accounts'
        );
        const rows = Array.isArray(res) ? res : (res.accounts ?? []);
        setAccounts(rows.map((r) => ({ id: r.id, name: r.name })));
        const fromUrl = new URLSearchParams(window.location.search).get(
          'accountId'
        );
        const daniel = rows.find((r) => /daniel/i.test(r.name));
        setAccountId(fromUrl ?? daniel?.id ?? rows[0]?.id ?? '');
      } catch (err) {
        setError(`Could not load accounts: ${(err as Error).message}`);
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      const res = await apiFetch<FeedResponse>(
        `/admin/delivered-feed?accountId=${encodeURIComponent(accountId)}&platform=${platform}&sinceMinutes=${windowMin}&limit=300`
      );
      setData(res);
      setError(null);
      setLastLoaded(new Date());
      const top = res.delivered[0]?.id ?? null;
      if (lastTopId.current && top && top !== lastTopId.current) {
        toast.message(
          `New ${platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} delivery: ${res.delivered[0].leadName ?? res.delivered[0].conversationId}`
        );
      }
      lastTopId.current = top;
    } catch (err) {
      setError((err as Error).message);
    }
  }, [accountId, platform, windowMin]);

  useEffect(() => {
    lastTopId.current = null;
    void load();
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load, paused]);

  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-end justify-between gap-4'>
        <div>
          <h2 className='text-2xl font-semibold tracking-tight'>
            Live delivery feed
          </h2>
          <p className='text-sm text-zinc-500'>
            Every AI message Meta accepted for delivery, newest first. Refreshes
            every {REFRESH_MS / 1000}s
            {lastLoaded ? `, last ${lastLoaded.toLocaleTimeString()}` : ''}.
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <select
            className='rounded-md border px-2 py-1 text-sm'
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className='rounded-md border px-2 py-1 text-sm'
            value={platform}
            onChange={(e) =>
              setPlatform(e.target.value as 'INSTAGRAM' | 'FACEBOOK')
            }
          >
            <option value='INSTAGRAM'>Instagram</option>
            <option value='FACEBOOK'>Facebook</option>
          </select>
          <select
            className='rounded-md border px-2 py-1 text-sm'
            value={windowMin}
            onChange={(e) => setWindowMin(Number(e.target.value))}
          >
            <option value={60}>last hour</option>
            <option value={360}>last 6 hours</option>
            <option value={1440}>last 24 hours</option>
            <option value={4320}>last 3 days</option>
            <option value={10080}>last 7 days</option>
          </select>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant='outline' size='sm' onClick={() => void load()}>
            Refresh now
          </Button>
        </div>
      </div>

      {accountId && <AiDeliveryCard accountId={accountId} compact />}

      {error && <p className='text-sm text-red-600'>{error}</p>}

      {data && (
        <>
          <div className='flex flex-wrap items-center gap-3 text-sm'>
            <Badge variant='outline'>{data.account.name}</Badge>
            <Badge variant='outline'>{data.platform}</Badge>
            {data.account.generateOnly ? (
              <Badge variant='secondary'>
                SUGGESTIONS ONLY, nothing delivers
              </Badge>
            ) : (
              <Badge className='bg-emerald-600 text-white'>LIVE</Badge>
            )}
            <span className='text-zinc-500'>
              {data.deliveredCount} delivered, {data.holdCount} held since{' '}
              {fmt(data.since)}
            </span>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className='text-base'>
                Delivered ({data.deliveredCount})
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              {data.delivered.length === 0 && (
                <p className='text-sm text-zinc-500'>
                  Nothing delivered in this window.
                </p>
              )}
              {data.delivered.map((m) => (
                <div key={m.id} className='rounded-md border p-3 text-sm'>
                  <div className='mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500'>
                    <span className='font-mono'>{fmt(m.deliveredAt)}</span>
                    <span className='font-medium text-zinc-800 dark:text-zinc-200'>
                      {m.leadName ?? 'unknown lead'}
                    </span>
                    {m.step != null && (
                      <Badge variant='outline'>step {m.step}</Badge>
                    )}
                    {m.gate ? (
                      m.gate.allow ? (
                        <Badge variant='outline'>gate ALLOW</Badge>
                      ) : (
                        <Badge className='bg-amber-500 text-white'>
                          gate {m.gate.reason}
                        </Badge>
                      )
                    ) : (
                      <Badge variant='secondary'>no gate row</Badge>
                    )}
                    <Link
                      className='underline'
                      href={`/dashboard/conversations?id=${m.conversationId}`}
                      target='_blank'
                    >
                      {m.conversationId}
                    </Link>
                  </div>
                  <div className='whitespace-pre-wrap'>{m.content}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='text-base'>
                Held by the gate ({data.holdCount})
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              {data.holds.length === 0 && (
                <p className='text-sm text-zinc-500'>
                  No holds in this window.
                </p>
              )}
              {data.holds.map((h, i) => (
                <div
                  key={`${h.conversationId}-${h.at}-${i}`}
                  className='rounded-md border border-amber-200 p-3 text-sm'
                >
                  <div className='mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500'>
                    <span className='font-mono'>{fmt(h.at)}</span>
                    <span className='font-medium text-zinc-800 dark:text-zinc-200'>
                      {h.leadName ?? 'unknown lead'}
                    </span>
                    <Badge className='bg-amber-500 text-white'>
                      {h.reason ?? 'HOLD'}
                    </Badge>
                    <Badge variant='outline'>{h.sendPath}</Badge>
                    {h.conversationId && (
                      <Link
                        className='underline'
                        href={`/dashboard/conversations?id=${h.conversationId}`}
                        target='_blank'
                      >
                        {h.conversationId}
                      </Link>
                    )}
                  </div>
                  <div className='whitespace-pre-wrap text-zinc-700 dark:text-zinc-300'>
                    {h.draft}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
