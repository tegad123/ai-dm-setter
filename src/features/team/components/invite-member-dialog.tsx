'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface InviteResponse {
  ok?: boolean;
  inviteUrl?: string;
  emailSent?: boolean;
  emailError?: string | null;
  error?: string;
}

const ROLE_OPTIONS = [
  { value: 'SETTER', label: 'Setter — handle DMs + book calls' },
  { value: 'CLOSER', label: 'Closer — runs calls + closes' },
  { value: 'ADMIN', label: 'Admin — full access' },
  { value: 'READ_ONLY', label: 'Read-only — view dashboards' }
];

export function InviteMemberDialog({
  trigger,
  onInvited
}: {
  trigger: React.ReactNode;
  onInvited?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [role, setRole] = React.useState<string>('SETTER');
  const [submitting, setSubmitting] = React.useState(false);
  const [inviteUrl, setInviteUrl] = React.useState<string | null>(null);
  const [emailSent, setEmailSent] = React.useState<boolean | null>(null);

  const reset = () => {
    setEmail('');
    setName('');
    setRole('SETTER');
    setInviteUrl(null);
    setEmailSent(null);
    setSubmitting(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), name: name.trim(), role })
      });
      const data = (await res.json().catch(() => ({}))) as InviteResponse;
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to invite member.');
        return;
      }
      setInviteUrl(data.inviteUrl ?? null);
      setEmailSent(data.emailSent ?? false);
      onInvited?.();
      toast.success(
        data.emailSent
          ? `Invite sent to ${email.trim()}.`
          : `Invite created — share the link below with ${email.trim()}.`
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Network error sending invite.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success('Invite link copied to clipboard.');
    } catch {
      toast.error('Could not copy. Select the link and copy manually.');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>
            They&apos;ll get an email with a sign-up link. They must use the
            same email address to claim the invite.
          </DialogDescription>
        </DialogHeader>
        {!inviteUrl ? (
          <form onSubmit={submit} className='space-y-4'>
            <div className='space-y-1'>
              <Label htmlFor='invite-email'>Email</Label>
              <Input
                id='invite-email'
                type='email'
                required
                placeholder='teammate@example.com'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                autoFocus
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='invite-name'>Name (optional)</Label>
              <Input
                id='invite-name'
                placeholder='Jane Doe'
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='invite-role'>Role</Label>
              <Select
                value={role}
                onValueChange={setRole}
                disabled={submitting}
              >
                <SelectTrigger id='invite-role'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type='button'
                variant='ghost'
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type='submit' disabled={submitting || !email}>
                {submitting ? 'Sending…' : 'Send invite'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className='space-y-4'>
            <div className='space-y-1'>
              <p className='text-sm font-medium'>
                {emailSent
                  ? 'Invite email sent.'
                  : 'Email skipped (no email service configured).'}
              </p>
              <p className='text-muted-foreground text-xs'>
                {emailSent
                  ? "Share the link below as a backup if they don't see the email."
                  : 'Share this link with your teammate so they can sign up.'}
              </p>
            </div>
            <div className='bg-muted flex items-center gap-2 rounded-md p-2'>
              <code className='flex-1 truncate text-xs'>{inviteUrl}</code>
              <Button type='button' size='sm' onClick={copyLink}>
                Copy
              </Button>
            </div>
            <DialogFooter>
              <Button
                type='button'
                variant='ghost'
                onClick={() => {
                  reset();
                }}
              >
                Invite another
              </Button>
              <Button type='button' onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
