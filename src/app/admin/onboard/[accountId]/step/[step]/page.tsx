// /admin/onboard/[accountId]/step/[step] — Steps 2-6.
// Server component looks up the account + owner, then dispatches to
// the matching step body. Step 1 lives at /admin/onboard/new because
// no accountId exists yet.

import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import prisma from '@/lib/prisma';
import { requireSuperAdmin } from '@/lib/auth-guard';
import { OnboardingWizardShell } from '@/features/admin/components/onboarding-wizard-shell';
import { Step2MetaConnect } from '@/features/admin/components/step2-meta-connect';
import { Step3PersonaForm } from '@/features/admin/components/step3-persona-form';
import { Step4TrainingData } from '@/features/admin/components/step4-training-data';
import { Step5TestRunner } from '@/features/admin/components/step5-test-runner';
import { Step6Activate } from '@/features/admin/components/step6-activate';

export const dynamic = 'force-dynamic';

interface OnboardStatus {
  accountId: string;
  name: string;
  slug: string;
  plan: string;
  planStatus: string;
  onboardingStep: number;
  onboardingComplete: boolean;
  awayModeInstagram: boolean;
  awayModeFacebook: boolean;
  owner: { id: string; email: string; name: string; isActive: boolean } | null;
  meta: { instagramConnected: boolean; facebookConnected: boolean };
  persona: {
    id: string;
    personaName: string;
    fullName: string;
    minimumCapitalRequired: number | null;
    configured: boolean;
  } | null;
  trainingCount: number;
}

async function fetchStatus(accountId: string): Promise<OnboardStatus | null> {
  const h = await headers();
  const cookie = h.get('cookie') ?? '';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host') ?? 'localhost:3000';
  const res = await fetch(
    `${proto}://${host}/api/admin/onboard/${accountId}/status`,
    { headers: { cookie }, cache: 'no-store' }
  );
  if (!res.ok) return null;
  return res.json();
}

export default async function OnboardStepPage({
  params
}: {
  params: Promise<{ accountId: string; step: string }>;
}) {
  await requireSuperAdmin();
  const { accountId, step } = await params;
  const stepNum = parseInt(step, 10);
  if (!Number.isFinite(stepNum) || stepNum < 2 || stepNum > 6) {
    notFound();
  }

  // Sanity-check the account exists; redirect to /admin if not.
  const acct = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, onboardingComplete: true }
  });
  if (!acct) notFound();
  if (acct.onboardingComplete) {
    redirect(`/admin/accounts/${accountId}`);
  }

  const status = await fetchStatus(accountId);
  if (!status) notFound();

  const titles: Record<number, string> = {
    2: 'Step 2 — Connect Meta',
    3: 'Step 3 — Configure persona',
    4: 'Step 4 — Training data',
    5: 'Step 5 — Test the AI',
    6: 'Step 6 — Activate'
  };
  const descriptions: Record<number, string> = {
    2: 'Owner needs to sign in and connect their Instagram + Facebook page from /dashboard/settings/integrations. You can refresh this page to confirm — or skip and circle back.',
    3: 'Set the core persona fields. The full persona editor (scripts, voice notes, etc.) lives at /dashboard/settings/persona once the account is active.',
    4: 'Upload sample conversations so the few-shot retriever has examples to draw from. Phase 2 routes uploads through the existing /dashboard/settings/training page.',
    5: 'Run 3 hardcoded scenarios (qualified lead, below-threshold lead, distress signal) against the new persona. All 3 must pass before activation.',
    6: 'Flip both away-mode toggles, mark onboarding complete, send the operator a "review first 10 conversations" notification, redirect to the account detail page.'
  };

  return (
    <OnboardingWizardShell
      accountId={accountId}
      step={stepNum}
      title={titles[stepNum]}
      description={descriptions[stepNum]}
    >
      {stepNum === 2 ? (
        <Step2MetaConnect status={status} />
      ) : stepNum === 3 ? (
        <Step3PersonaForm status={status} />
      ) : stepNum === 4 ? (
        <Step4TrainingData status={status} />
      ) : stepNum === 5 ? (
        <Step5TestRunner status={status} />
      ) : stepNum === 6 ? (
        <Step6Activate status={status} />
      ) : null}
    </OnboardingWizardShell>
  );
}
