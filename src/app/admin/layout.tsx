// ---------------------------------------------------------------------------
// /admin layout
// ---------------------------------------------------------------------------
// Server component. Runs requireSuperAdmin on every navigation. On 403,
// redirects the user to /dashboard so a regular tenant never sees the
// /admin chrome at all (the spec calls this out explicitly: "Tenants
// never see /admin routes or data"). Renders a separate sidebar from
// the tenant dashboard layout.
// ---------------------------------------------------------------------------

import { redirect } from 'next/navigation';
import { requireSuperAdmin, AuthError } from '@/lib/auth-guard';
import { AdminSidebar } from '@/features/admin/components/admin-sidebar';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children
}: {
  children: React.ReactNode;
}) {
  try {
    await requireSuperAdmin();
  } catch (err) {
    if (err instanceof AuthError && err.status === 403) {
      redirect('/dashboard');
    }
    throw err;
  }

  return (
    <div className='flex min-h-screen bg-zinc-50 dark:bg-zinc-950'>
      <AdminSidebar />
      <main className='flex-1 overflow-x-auto p-8'>{children}</main>
    </div>
  );
}
