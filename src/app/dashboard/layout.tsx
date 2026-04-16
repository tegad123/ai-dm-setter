import KBar from '@/components/kbar';
import AppSidebar from '@/components/layout/app-sidebar';
import Header from '@/components/layout/header';
import { ApiKeyBanner } from '@/components/api-key-banner';
import { TrainingBanner } from '@/components/training-banner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';

export const metadata: Metadata = {
  title: 'DMsetter — Dashboard',
  description: 'AI-powered DM automation dashboard',
  robots: {
    index: false,
    follow: false
  }
};

export default async function DashboardLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar_state')?.value === 'true';
  return (
    <KBar>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar />
        <SidebarInset>
          <Header />
          <ApiKeyBanner />
          <TrainingBanner />
          {children}
        </SidebarInset>
      </SidebarProvider>
    </KBar>
  );
}
