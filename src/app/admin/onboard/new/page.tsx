// /admin/onboard/new — Step 1 of the onboarding wizard.
// Server component to enforce auth; the form itself is a client.

import { requireSuperAdmin } from '@/lib/auth-guard';
import { OnboardingWizardShell } from '@/features/admin/components/onboarding-wizard-shell';
import { Step1CreateAccountForm } from '@/features/admin/components/step1-create-account-form';

export const dynamic = 'force-dynamic';

export default async function NewOnboardPage() {
  await requireSuperAdmin();
  return (
    <OnboardingWizardShell
      step={1}
      title='Step 1 — Create account'
      description='Provision the workspace + owner user. The owner will sign in via Clerk; nothing ships to them until you activate in Step 6.'
    >
      <Step1CreateAccountForm />
    </OnboardingWizardShell>
  );
}
