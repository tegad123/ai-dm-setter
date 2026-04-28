'use client';

// Step 6 — final activation. Lists the prerequisites, lets the
// super-admin tick "I reviewed everything", then POSTs to /activate.

import * as React from 'react';
import { useRouter } from 'next/navigation';

interface Status {
  accountId: string;
  name: string;
  meta: { instagramConnected: boolean; facebookConnected: boolean };
  persona: { configured: boolean } | null;
  trainingCount: number;
  awayModeInstagram: boolean;
  awayModeFacebook: boolean;
}

export function Step6Activate({ status }: { status: Status }) {
  const router = useRouter();
  const [acknowledge, setAcknowledge] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/onboard/${status.accountId}/activate`,
        { method: 'POST' }
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok)
        throw new Error(body.error ?? `Failed (${res.status})`);
      router.push(`/admin/accounts/${status.accountId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className='space-y-5'>
      <div className='rounded-md bg-zinc-50 p-4 dark:bg-zinc-950'>
        <p className='text-sm font-medium'>{status.name}</p>
        <p className='text-xs text-zinc-500'>
          One last review. Activation flips both away-mode toggles on, marks
          onboarding complete, and creates a SYSTEM notification for you to
          review the first 10 conversations after the AI starts handling inbound
          DMs.
        </p>
      </div>

      <ul className='space-y-2'>
        <Check
          ok={status.meta.instagramConnected}
          label='Instagram credential connected'
          warning='You can activate without IG connected — but no IG DMs will be processed until the owner connects.'
        />
        <Check
          ok={status.meta.facebookConnected}
          label='Facebook credential connected'
          warning='Same caveat as Instagram — connection can land later.'
        />
        <Check
          ok={Boolean(status.persona?.configured)}
          label='Persona core fields configured (Step 3)'
        />
        <Check
          ok={status.trainingCount > 0}
          label={`Training corpus has ${status.trainingCount} example${status.trainingCount === 1 ? '' : 's'}`}
          warning='Few-shot retrieval is degraded with zero training examples — strongly recommend uploading 10+ before activation.'
        />
        <Check
          ok={!status.awayModeInstagram && !status.awayModeFacebook}
          label='Away-mode currently OFF (will be flipped ON by activation)'
        />
      </ul>

      <label className='flex items-start gap-2 rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-950'>
        <input
          type='checkbox'
          checked={acknowledge}
          onChange={(e) => setAcknowledge(e.target.checked)}
          className='mt-0.5'
        />
        <span>
          I&apos;ve reviewed the persona configuration and accept that AI
          auto-send will start firing on every new lead inbound for this account
          immediately after activation.
        </span>
      </label>

      {error ? (
        <p className='rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-400'>
          {error}
        </p>
      ) : null}

      <div className='flex items-center justify-end border-t border-zinc-100 pt-4 dark:border-zinc-800'>
        <button
          type='button'
          onClick={submit}
          disabled={!acknowledge || submitting}
          className='rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60'
        >
          {submitting ? 'Activating…' : 'Activate account ✓'}
        </button>
      </div>
    </div>
  );
}

function Check({
  ok,
  label,
  warning
}: {
  ok: boolean;
  label: string;
  warning?: string;
}) {
  return (
    <li className='flex items-start gap-3 rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800'>
      <span
        className={
          'mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full ' +
          (ok ? 'bg-emerald-500' : 'bg-amber-500')
        }
      />
      <div className='flex-1'>
        <p className='text-sm'>{label}</p>
        {!ok && warning ? (
          <p className='mt-0.5 text-xs text-amber-700 dark:text-amber-400'>
            {warning}
          </p>
        ) : null}
      </div>
    </li>
  );
}
