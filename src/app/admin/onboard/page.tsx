// /admin/onboard — landing for the onboarding wizard.
// Lists incomplete onboardings (resume) + a "Start new" button.

import Link from 'next/link';
import prisma from '@/lib/prisma';
import { requireSuperAdmin } from '@/lib/auth-guard';

export const dynamic = 'force-dynamic';

export default async function AdminOnboardListPage() {
  await requireSuperAdmin();
  const inProgress = await prisma.account.findMany({
    where: { onboardingComplete: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      slug: true,
      onboardingStep: true,
      planStatus: true,
      createdAt: true,
      users: {
        where: { role: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { email: true, name: true }
      }
    },
    take: 50
  });

  return (
    <div className='space-y-6'>
      <div className='flex items-end justify-between'>
        <div>
          <h2 className='text-2xl font-semibold tracking-tight'>
            Onboard a new client
          </h2>
          <p className='text-sm text-zinc-500'>
            6-step wizard: account → Meta connect → persona → training → test →
            activate.
          </p>
        </div>
        <Link
          href='/admin/onboard/new'
          className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700'
        >
          + Start new onboarding
        </Link>
      </div>

      <section className='rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900'>
        <h3 className='mb-3 text-sm font-semibold tracking-wide text-zinc-500 uppercase'>
          In progress
        </h3>
        {inProgress.length === 0 ? (
          <p className='text-sm text-zinc-500'>
            No incomplete onboardings. Click + Start new onboarding to begin.
          </p>
        ) : (
          <ul className='divide-y divide-zinc-100 dark:divide-zinc-800'>
            {inProgress.map((a) => {
              const owner = a.users[0];
              const nextStep = Math.min(6, Math.max(1, a.onboardingStep + 1));
              return (
                <li
                  key={a.id}
                  className='flex items-center justify-between gap-4 py-3'
                >
                  <div>
                    <p className='font-medium'>{a.name}</p>
                    <p className='text-xs text-zinc-500'>
                      {owner?.name ?? '—'} · {owner?.email ?? '—'} ·{' '}
                      {a.planStatus} · created{' '}
                      {a.createdAt.toLocaleDateString('en-US')}
                    </p>
                  </div>
                  <div className='flex items-center gap-3'>
                    <span className='text-xs text-zinc-500'>
                      Step {a.onboardingStep} / 6
                    </span>
                    <Link
                      href={`/admin/onboard/${a.id}/step/${nextStep}`}
                      className='rounded border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
                    >
                      Resume →
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
