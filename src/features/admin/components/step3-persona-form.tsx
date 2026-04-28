'use client';

// Step 3 — persona core fields. Posts to /api/admin/onboard/:id/persona
// which writes through to AIPersona + bumps onboardingStep → 3.

import * as React from 'react';
import { useRouter } from 'next/navigation';

interface Status {
  accountId: string;
  persona: {
    id: string;
    personaName: string;
    fullName: string;
    minimumCapitalRequired: number | null;
  } | null;
}

interface FormState {
  fullName: string;
  personaName: string;
  tone: string;
  adminBio: string;
  whatTheySell: string;
  closerName: string;
  minimumCapitalRequired: string; // string for input control; coerced on submit
  homeworkUrl: string;
  youtubeFallbackUrl: string;
  downsellUrl: string;
  downsellPriceUsd: string;
  typeformUrl: string;
  scopeAndLimits: string;
  verifiedFacts: string;
}

export function Step3PersonaForm({ status }: { status: Status }) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => ({
    fullName: status.persona?.fullName ?? '',
    personaName: status.persona?.personaName ?? '',
    tone: 'casual, direct, friendly',
    adminBio: '',
    whatTheySell: '',
    closerName: '',
    minimumCapitalRequired:
      status.persona?.minimumCapitalRequired != null
        ? String(status.persona.minimumCapitalRequired)
        : '1000',
    homeworkUrl: '',
    youtubeFallbackUrl: '',
    downsellUrl: '',
    downsellPriceUsd: '497',
    typeformUrl: '',
    scopeAndLimits: '',
    verifiedFacts: ''
  }));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof FormState>(k: K, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/onboard/${status.accountId}/persona`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...form,
            minimumCapitalRequired:
              form.minimumCapitalRequired.trim() === ''
                ? null
                : Number(form.minimumCapitalRequired),
            downsellPriceUsd:
              form.downsellPriceUsd.trim() === ''
                ? null
                : Number(form.downsellPriceUsd)
          })
        }
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      router.push(`/admin/onboard/${status.accountId}/step/4`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className='space-y-4'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label='Persona display name'>
          <input
            required
            value={form.personaName}
            onChange={(e) => set('personaName', e.target.value)}
            className={inputCls}
            disabled={submitting}
          />
        </Field>
        <Field label='Full name (used in scripts)'>
          <input
            required
            value={form.fullName}
            onChange={(e) => set('fullName', e.target.value)}
            className={inputCls}
            disabled={submitting}
          />
        </Field>
      </div>
      <Field label='Tone (comma-separated adjectives)'>
        <input
          value={form.tone}
          onChange={(e) => set('tone', e.target.value)}
          className={inputCls}
          disabled={submitting}
        />
      </Field>
      <Field label='Admin bio — who is this persona?'>
        <textarea
          value={form.adminBio}
          onChange={(e) => set('adminBio', e.target.value)}
          rows={3}
          placeholder='4-year prop trader, helps US/CA traders scale through funded accounts.'
          className={inputCls}
          disabled={submitting}
        />
      </Field>
      <Field label='What do they sell?'>
        <textarea
          value={form.whatTheySell}
          onChange={(e) => set('whatTheySell', e.target.value)}
          rows={2}
          placeholder='1:1 mentorship + funded-account program; $1,500 / call delivers strategy + risk plan.'
          className={inputCls}
          disabled={submitting}
        />
      </Field>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label='Closer name (handoff)'>
          <input
            value={form.closerName}
            onChange={(e) => set('closerName', e.target.value)}
            placeholder='Anthony'
            className={inputCls}
            disabled={submitting}
          />
        </Field>
        <Field label='Minimum capital required (USD)'>
          <input
            type='number'
            min={0}
            value={form.minimumCapitalRequired}
            onChange={(e) => set('minimumCapitalRequired', e.target.value)}
            className={inputCls}
            disabled={submitting}
          />
        </Field>
      </div>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label='Typeform / booking URL'>
          <input
            type='url'
            value={form.typeformUrl}
            onChange={(e) => set('typeformUrl', e.target.value)}
            placeholder='https://form.typeform.com/to/...'
            className={inputCls}
            disabled={submitting}
          />
        </Field>
        <Field label='YouTube fallback URL'>
          <input
            type='url'
            value={form.youtubeFallbackUrl}
            onChange={(e) => set('youtubeFallbackUrl', e.target.value)}
            placeholder='https://youtube.com/@channel'
            className={inputCls}
            disabled={submitting}
          />
        </Field>
      </div>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <Field label='Downsell URL ($497 course / similar)'>
          <input
            type='url'
            value={form.downsellUrl}
            onChange={(e) => set('downsellUrl', e.target.value)}
            placeholder='https://whop.com/checkout/...'
            className={inputCls}
            disabled={submitting}
          />
        </Field>
        <Field label='Downsell price (USD)'>
          <input
            type='number'
            min={0}
            step={1}
            value={form.downsellPriceUsd}
            onChange={(e) => set('downsellPriceUsd', e.target.value)}
            className={inputCls}
            disabled={submitting}
          />
        </Field>
      </div>
      <Field label='Homework URL (optional)'>
        <input
          type='url'
          value={form.homeworkUrl}
          onChange={(e) => set('homeworkUrl', e.target.value)}
          placeholder='https://...'
          className={inputCls}
          disabled={submitting}
        />
      </Field>
      <Field label='Scope and limits (free-text)'>
        <textarea
          rows={2}
          value={form.scopeAndLimits}
          onChange={(e) => set('scopeAndLimits', e.target.value)}
          placeholder='US/CA only. Do not give specific entry signals. Do not opine on prop firms beyond what is in verifiedFacts.'
          className={inputCls}
          disabled={submitting}
        />
      </Field>
      <Field label='Verified facts the AI may cite (free-text)'>
        <textarea
          rows={2}
          value={form.verifiedFacts}
          onChange={(e) => set('verifiedFacts', e.target.value)}
          className={inputCls}
          disabled={submitting}
        />
      </Field>

      {error ? (
        <p className='rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-400'>
          {error}
        </p>
      ) : null}

      <div className='flex items-center justify-end border-t border-zinc-100 pt-4 dark:border-zinc-800'>
        <button
          type='submit'
          disabled={submitting}
          className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60'
        >
          {submitting ? 'Saving…' : 'Save + continue →'}
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
