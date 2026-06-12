'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/use-auth';
import { useUser } from '@clerk/nextjs';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

export default function ProfileViewPage() {
  const { user } = useAuth();
  const { user: clerkUser } = useUser();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [updatingPassword, setUpdatingPassword] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
    }
  }, [user]);

  const handleUpdatePassword = async () => {
    if (!newPassword || !confirmPassword) {
      toast.error('Enter and confirm your new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('New password and confirmation do not match.');
      return;
    }
    if (!clerkUser) {
      toast.error('Not signed in.');
      return;
    }
    setUpdatingPassword(true);
    try {
      // Clerk client-side password update. currentPassword is required when
      // the user already has a password set; signOutOfOtherSessions is a safe
      // default after a password change.
      await clerkUser.updatePassword({
        currentPassword: currentPassword || undefined,
        newPassword,
        signOutOfOtherSessions: true
      });
      toast.success('Password updated.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const msg =
        (err as { errors?: { message?: string }[] })?.errors?.[0]?.message ||
        (err instanceof Error ? err.message : 'Could not update password.');
      toast.error(msg);
    } finally {
      setUpdatingPassword(false);
    }
  };

  return (
    <div className='flex w-full flex-col gap-6 p-4'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Profile</h2>
        <p className='text-muted-foreground'>
          Manage your account settings and preferences
        </p>
      </div>

      <Separator />

      <div className='grid gap-6 md:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>Personal Information</CardTitle>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex items-center gap-4'>
              <Avatar className='h-16 w-16'>
                <AvatarFallback className='bg-primary/10 text-primary text-lg font-semibold'>
                  {user?.name
                    ?.split(' ')
                    .map((n) => n[0])
                    .join('') || 'U'}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className='font-semibold'>{user?.name || 'User'}</p>
                <p className='text-muted-foreground text-sm'>
                  {user?.role || ''}
                </p>
              </div>
            </div>
            <div className='space-y-2'>
              <Label htmlFor='name'>Full Name</Label>
              <Input
                id='name'
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='email'>Email</Label>
              <Input
                id='email'
                type='email'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button>Save Changes</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='current-password'>Current Password</Label>
              <Input
                id='current-password'
                type='password'
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='new-password'>New Password</Label>
              <Input
                id='new-password'
                type='password'
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='confirm-password'>Confirm New Password</Label>
              <Input
                id='confirm-password'
                type='password'
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <Button
              onClick={handleUpdatePassword}
              disabled={updatingPassword || !newPassword || !confirmPassword}
            >
              {updatingPassword ? 'Updating…' : 'Update Password'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
