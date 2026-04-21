import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { LandingPage } from '@/features/landing/components/landing-page';

// ---------------------------------------------------------------------------
// Root route behavior:
//   - Authenticated operator → redirect to /dashboard/overview (previous
//     behavior — logged-in users always land on the command center)
//   - Anonymous visitor → render the marketing landing page with CTAs
//     pointing to /auth/sign-up
// ---------------------------------------------------------------------------

export default async function Page() {
  const { userId } = await auth();
  if (userId) {
    redirect('/dashboard/overview');
  }
  return <LandingPage />;
}
