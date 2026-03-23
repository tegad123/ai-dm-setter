import { Metadata } from 'next';
import SignUpViewPage from '@/features/auth/components/sign-up-view';

export const metadata: Metadata = {
  title: 'DMsetter | Sign Up',
  description: 'Create your account.'
};

export default function Page() {
  return <SignUpViewPage />;
}
