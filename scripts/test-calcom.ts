// Dev-only: verify Cal.com v2 integration end-to-end (availability + real
// booking, then cancel). Saves the key, forces Cal.com active, tests, resets
// active provider back to Google.
//
// Usage: npx tsx scripts/test-calcom.ts

import prisma from '../src/lib/prisma';
import { setCredentials } from '../src/lib/credential-store';
import {
  getUnifiedAvailability,
  bookUnifiedAppointment
} from '../src/lib/calendar-adapter';

const KEY = 'cal_live_741d69a483284721b815e89cd903dde0';

async function main() {
  const g = await prisma.integrationCredential.findFirst({
    where: { provider: 'GOOGLE_CALENDAR', isActive: true },
    select: { accountId: true }
  });
  const accountId = g!.accountId;
  console.log('account:', accountId);

  await setCredentials(accountId, 'CALCOM', { apiKey: KEY }, {});
  await prisma.account.update({
    where: { id: accountId },
    data: { activeCalendarProvider: 'CALCOM' }
  });

  const avail = await getUnifiedAvailability(
    accountId,
    undefined,
    undefined,
    'Asia/Karachi'
  );
  console.log('\n=== availability ===');
  console.log('provider:', avail.provider, '| slots:', avail.slots.length);
  console.log('first slot:', avail.slots[0]);
  if (avail.slots.length === 0) {
    console.log('No slots; aborting booking test');
    return;
  }

  const slot = avail.slots[0].start;
  const r = await bookUnifiedAppointment(accountId, {
    leadName: 'Adapter CalcomTest',
    leadHandle: 'calcom_test',
    platform: 'INSTAGRAM',
    slotStart: slot,
    timezone: 'Asia/Karachi',
    leadEmail: 'calcom-test@example.com'
  });
  console.log('\n=== booking ===');
  console.log(
    'provider:',
    r.provider,
    '| success:',
    r.success,
    '| uid:',
    r.bookingId,
    '| apptId:',
    r.appointmentId,
    '| meet:',
    r.meetingUrl
  );
  if (r.error) console.log('error:', r.error);

  if (r.success && r.bookingId) {
    const cancel = await fetch(
      `https://api.cal.com/v2/bookings/${r.bookingId}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          'cal-api-version': '2024-08-13'
        },
        body: JSON.stringify({ cancellationReason: 'automated adapter test' })
      }
    );
    console.log(
      '\ncancel HTTP',
      cancel.status,
      (await cancel.text()).slice(0, 200)
    );
  }
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    const g = await prisma.integrationCredential.findFirst({
      where: { provider: 'GOOGLE_CALENDAR', isActive: true },
      select: { accountId: true }
    });
    if (g)
      await prisma.account.update({
        where: { id: g.accountId },
        data: { activeCalendarProvider: 'GOOGLE_CALENDAR' }
      });
    await prisma.$disconnect();
  });
