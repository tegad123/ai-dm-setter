'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

export function ApiKeyBanner() {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Don't re-check if user dismissed this session
    if (sessionStorage.getItem('api-key-banner-dismissed')) return;

    async function check() {
      try {
        const res = await apiFetch<{ hasAiKey: boolean }>(
          '/settings/integrations/ai-status'
        );
        if (!res.hasAiKey) {
          setShow(true);
        }
      } catch {
        // Silently fail — don't block the UI
      }
    }
    check();
  }, []);

  if (!show || dismissed) return null;

  return (
    <div className='border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/50'>
      <div className='mx-auto flex max-w-screen-2xl items-center justify-between'>
        <div className='flex items-center gap-3'>
          <AlertTriangle className='h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400' />
          <p className='text-sm text-amber-800 dark:text-amber-200'>
            <strong>AI replies are paused</strong> — No API key configured. Your
            AI cannot respond to leads until you add an OpenAI or Anthropic key.{' '}
            <Link
              href='/dashboard/settings/integrations'
              className='font-semibold underline hover:text-amber-900 dark:hover:text-amber-100'
            >
              Go to Settings → Integrations
            </Link>
          </p>
        </div>
        <button
          onClick={() => {
            setDismissed(true);
            sessionStorage.setItem('api-key-banner-dismissed', '1');
          }}
          className='p-1 text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200'
          aria-label='Dismiss'
        >
          <X className='h-4 w-4' />
        </button>
      </div>
    </div>
  );
}
