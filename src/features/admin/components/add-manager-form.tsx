'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function AddManagerForm() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [inviteUrl, setInviteUrl] = React.useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setInviteUrl('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        inviteUrl: string;
        emailSent: boolean;
      }>('/api/admin/managers', {
        method: 'POST',
        body: JSON.stringify({ name, email })
      });
      setInviteUrl(res.inviteUrl);
      toast.success(
        res.emailSent ? 'Manager invite sent' : 'Manager invite created'
      );
      setName('');
      setEmail('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invite failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className='rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h3 className='text-sm font-semibold'>Manager access</h3>
          <p className='text-xs text-zinc-500'>
            Invite an operator with all-account conversation access and no
            billing/settings permissions.
          </p>
        </div>
        <Button type='button' onClick={() => setOpen((v) => !v)}>
          Add Manager
        </Button>
      </div>
      {open ? (
        <form onSubmit={submit} className='mt-4 grid gap-3 md:grid-cols-3'>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Manager name'
          />
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder='manager@example.com'
            type='email'
          />
          <Button type='submit' disabled={saving}>
            {saving ? 'Sending...' : 'Send Invite'}
          </Button>
          {inviteUrl ? (
            <p className='text-xs break-all text-zinc-500 md:col-span-3'>
              Invite link: {inviteUrl}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
