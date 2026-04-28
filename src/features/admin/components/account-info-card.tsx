// Section A — account info card. Plain key/value grid.

interface SectionA {
  id: string;
  name: string;
  slug: string;
  ownerName: string | null;
  ownerEmail: string | null;
  plan: string;
  planStatus: string;
  trialEndsAt: string | null;
  onboardingComplete: boolean;
  onboardingStep: number;
  createdAt: string;
  updatedAt: string;
  instagramPageId: unknown;
  facebookPageId: unknown;
  lastWebhookAt: string | null;
  adminUsers: Array<{
    id: string;
    email: string;
    name: string;
    role: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

function fmt(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short'
      })
    : '—';
}

export function AccountInfoCard({ sectionA }: { sectionA: SectionA }) {
  return (
    <section className='rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900'>
      <header className='mb-4'>
        <h3 className='text-sm font-semibold tracking-wide text-zinc-500 uppercase'>
          Account info
        </h3>
      </header>
      <dl className='grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3'>
        <Field label='Business name' value={sectionA.name} />
        <Field label='Slug' value={sectionA.slug} />
        <Field label='Owner' value={sectionA.ownerName ?? '—'} />
        <Field label='Owner email' value={sectionA.ownerEmail ?? '—'} />
        <Field label='Plan' value={sectionA.plan} />
        <Field label='Plan status' value={sectionA.planStatus} />
        <Field label='Trial ends' value={fmt(sectionA.trialEndsAt)} />
        <Field
          label='Onboarding'
          value={
            sectionA.onboardingComplete
              ? 'Complete'
              : `Step ${sectionA.onboardingStep}`
          }
        />
        <Field label='Created' value={fmt(sectionA.createdAt)} />
        <Field
          label='Instagram Page ID'
          value={String(sectionA.instagramPageId ?? '—')}
        />
        <Field
          label='Facebook Page ID'
          value={String(sectionA.facebookPageId ?? '—')}
        />
        <Field
          label='Last webhook message'
          value={fmt(sectionA.lastWebhookAt)}
        />
      </dl>
      {sectionA.adminUsers.length > 0 ? (
        <div className='mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800'>
          <p className='mb-2 text-xs tracking-wide text-zinc-500 uppercase'>
            Admin users
          </p>
          <ul className='space-y-1 text-sm'>
            {sectionA.adminUsers.map((u) => (
              <li key={u.id} className='flex items-center gap-2'>
                <span className='font-medium'>{u.name}</span>
                <span className='text-xs text-zinc-500'>{u.email}</span>
                {!u.isActive ? (
                  <span className='rounded bg-amber-100 px-1.5 py-0.5 text-[10px] tracking-wide text-amber-700 uppercase dark:bg-amber-900/40 dark:text-amber-400'>
                    Inactive
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className='text-xs tracking-wide text-zinc-500 uppercase'>{label}</dt>
      <dd className='mt-0.5 text-sm break-words'>{value}</dd>
    </div>
  );
}
