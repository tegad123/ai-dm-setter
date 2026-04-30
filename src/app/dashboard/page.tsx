import { redirect } from 'next/navigation';
import { requireAuth, isPlatformOperator } from '@/lib/auth-guard';

export default async function Dashboard() {
  const auth = await requireAuth();
  if (isPlatformOperator(auth.role)) {
    redirect('/admin');
  }
  redirect('/dashboard/overview');
}
