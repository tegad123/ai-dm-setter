import { forbidden } from 'next/navigation';
import { requireAuth, isPlatformOperator } from '@/lib/auth-guard';

export default async function BillingSettingsPage() {
  const auth = await requireAuth();
  if (isPlatformOperator(auth.role)) {
    forbidden();
  }

  return (
    <div className='flex flex-1 flex-col gap-4 p-4 md:p-6'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Billing</h2>
        <p className='text-muted-foreground'>
          Billing controls are managed by the QualifyDMs team.
        </p>
      </div>
    </div>
  );
}
