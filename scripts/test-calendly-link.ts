// Dev-only: verify Calendly link-mode booking against the real connected token.
// Finds the account with a CALENDLY integration, forces it active, and runs
// bookUnifiedAppointment to confirm a real single-use scheduling link is minted.
//
// Usage: npx tsx scripts/test-calendly-link.ts

import prisma from '../src/lib/prisma';
import { bookUnifiedAppointment } from '../src/lib/calendar-adapter';

async function main() {
  const cred = await prisma.integrationCredential.findFirst({
    where: { provider: 'CALENDLY', isActive: true },
    select: { accountId: true, metadata: true }
  });
  if (!cred) {
    console.log('No connected CALENDLY integration found.');
    return;
  }
  console.log('CALENDLY account:', cred.accountId);
  console.log('Stored metadata:', JSON.stringify(cred.metadata));

  // Force Calendly active so precedence/Google doesn't win
  await prisma.account.update({
    where: { id: cred.accountId },
    data: { activeCalendarProvider: 'CALENDLY' }
  });

  const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = await bookUnifiedAppointment(cred.accountId, {
    leadName: 'Test Lead',
    leadHandle: 'test_lead',
    platform: 'INSTAGRAM',
    slotStart: start
  });

  console.log('\n=== bookUnifiedAppointment result ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nbookingUrl:', result.bookingUrl || '(none)');
  console.log('requiresLeadAction:', result.requiresLeadAction);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
