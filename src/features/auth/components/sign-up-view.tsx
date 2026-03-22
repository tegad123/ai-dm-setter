'use client';

import { SignUp } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { InteractiveGridPattern } from './interactive-grid';

export default function SignUpViewPage() {
  return (
    <div className='relative h-screen flex-col items-center justify-center md:grid lg:max-w-none lg:grid-cols-2 lg:px-0'>
      <div className='bg-muted relative hidden h-full flex-col p-10 text-white lg:flex dark:border-r'>
        <div className='absolute inset-0 bg-zinc-900' />
        <div className='relative z-20 flex items-center text-lg font-medium'>
          <div className='bg-primary text-primary-foreground mr-2 flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold'>
            AI
          </div>
          AI DM Setter
        </div>
        <InteractiveGridPattern
          className={cn(
            'mask-[radial-gradient(400px_circle_at_center,white,transparent)]',
            'inset-x-0 inset-y-[0%] h-full skew-y-12'
          )}
        />
        <div className='relative z-20 mt-auto'>
          <blockquote className='space-y-2'>
            <p className='text-lg'>
              &ldquo;The AI DM Setter has completely transformed how we handle
              lead qualification and booking.&rdquo;
            </p>
            <footer className='text-sm'>AI DM Setter</footer>
          </blockquote>
        </div>
      </div>
      <div className='flex h-full items-center justify-center p-4 lg:p-8'>
        <SignUp
          appearance={{
            elements: {
              rootBox: 'mx-auto',
              cardBox: 'shadow-none border-0',
              card: 'shadow-none border-0'
            }
          }}
          signInUrl='/auth/sign-in'
          forceRedirectUrl='/dashboard/overview'
        />
      </div>
    </div>
  );
}
