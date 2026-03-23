import { Metadata } from 'next';
import SignInViewPage from '@/features/auth/components/sign-in-view';

export const metadata: Metadata = {
  title: 'DMsetter | Sign In',
  description: 'Sign in to your dashboard.'
};

export default function Page() {
  return <SignInViewPage />;
}
