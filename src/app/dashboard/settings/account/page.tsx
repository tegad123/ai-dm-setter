'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface AccountData {
  id: string;
  name: string | null;
  slug: string | null;
  brandName: string | null;
  plan: string;
  onboardingComplete: boolean;
}

export default function AccountSettingsPage() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [brandName, setBrandName] = useState('');

  useEffect(() => {
    apiFetch<{ account: AccountData }>('/settings/account')
      .then(({ account }) => {
        setAccount(account);
        setName(account.name || '');
        setBrandName(account.brandName || '');
      })
      .catch(() => toast.error('Failed to load account settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await apiFetch<{ account: AccountData }>(
        '/settings/account',
        {
          method: 'PUT',
          body: JSON.stringify({ name, brandName })
        }
      );
      setAccount(updated.account);
      toast.success('Account settings saved');
    } catch {
      toast.error('Failed to save account settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className='flex flex-1 items-center justify-center p-6'>
        <Loader2 className='text-muted-foreground h-6 w-6 animate-spin' />
      </div>
    );
  }

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Account Settings</h2>
        <p className='text-muted-foreground'>
          Manage your account name, branding, and plan
        </p>
      </div>

      <Separator />

      <div className='grid gap-6'>
        <Card>
          <CardHeader>
            <CardTitle>Account Details</CardTitle>
            <CardDescription>
              Basic information about your account
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='account-name'>Account Name</Label>
              <Input
                id='account-name'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='Your account name'
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='brand-name'>Brand Name</Label>
              <Input
                id='brand-name'
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder='Your brand or business name'
              />
              <p className='text-muted-foreground text-xs'>
                This is the name the AI uses when referring to your business in
                conversations.
              </p>
            </div>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
              Save Changes
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Your current subscription plan</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex items-center gap-3'>
              <Badge variant='secondary' className='text-sm'>
                {account?.plan || 'Free'}
              </Badge>
              {account?.onboardingComplete && (
                <span className='text-muted-foreground text-sm'>
                  Onboarding complete
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
