'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

interface FormState {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  plan: 'FREE' | 'PRO' | 'ENTERPRISE';
}

const initial: FormState = {
  businessName: '',
  ownerName: '',
  ownerEmail: '',
  ownerPhone: '',
  plan: 'FREE'
};

export function Step1CreateAccountForm() {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(initial);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/onboard/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const body = (await res.json().catch(() => ({}))) as {
        accountId?: string;
        error?: string;
      };
      if (!res.ok || !body.accountId) {
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      router.push(`/admin/onboard/${body.accountId}/step/2`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className='space-y-4'>
      <Field label='Business name'>
        <input
          required
          minLength={2}
          value={form.businessName}
          onChange={(e) => set('businessName', e.target.value)}
          placeholder='Acme Trading Co.'
          className={inputCls}
          disabled={submitting}
        />
      </Field>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label='Owner name'>
          <input
            required
            value={form.ownerName}
            onChange={(e) => set('ownerName', e.target.value)}
            placeholder='Jane Doe'
            className={inputCls}
            disabled={submitting}
          />
        </Field>
        <Field label='Owner email'>
          <input
            required
            type='email'
            value={form.ownerEmail}
            onChange={(e) => set('ownerEmail', e.target.value)}
            placeholder='owner@example.com'
            className={inputCls}
            disabled={submitting}
          />
        </Field>
      </div>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label='Owner phone (optional)'>
          <input
            type='tel'
            value={form.ownerPhone}
            onChange={(e) => set('ownerPhone', e.target.value)}
            placeholder='+1 555 555 1234'
            className={inputCls}
            disabled={submitting}
          />
        </Field>
        <Field label='Plan'>
          <select
            value={form.plan}
            onChange={(e) => set('plan', e.target.value as FormState['plan'])}
            className={inputCls}
            disabled={submitting}
          >
            <option value='FREE'>FREE — onboarding / trial</option>
            <option value='PRO'>PRO</option>
            <option value='ENTERPRISE'>ENTERPRISE</option>
          </select>
        </Field>
      </div>

      {error ? (
        <p className='rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-400'>
          {error}
        </p>
      ) : null}

      <div className='flex items-center justify-between border-t border-zinc-100 pt-4 dark:border-zinc-800'>
        <p className='text-xs text-zinc-500'>
          A 14-day trial starts now (TRIAL planStatus). You can change the plan
          later.
        </p>
        <button
          type='submit'
          disabled={submitting}
          className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60'
        >
          {submitting ? 'Creating…' : 'Create + continue →'}
        </button>
      </div>
    </form>
  );
}

const inputCls =
  'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950';

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className='block'>
      <span className='mb-1 block text-xs font-medium tracking-wide text-zinc-600 uppercase dark:text-zinc-400'>
        {label}
      </span>
      {children}
    </label>
  );
}
