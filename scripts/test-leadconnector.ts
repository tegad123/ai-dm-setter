/**
 * Local smoke test for the LeadConnector (HighLevel) calendar integration.
 *
 * What this does:
 *   1. Loads the LEADCONNECTOR credentials from the database for the first
 *      account (decrypts apiKey inline so we don't need to import the
 *      credential-store path-aliased module).
 *   2. Calls GET /calendars/{calendarId}/free-slots against the real
 *      HighLevel API with a 7-day window.
 *   3. Prints the raw response shape and the parsed slot count.
 *   4. If --book is passed as a CLI flag, also attempts a live booking for
 *      the first available slot using a fake test contact. This is
 *      DESTRUCTIVE — it creates a real appointment in GHL. Do not pass
 *      --book unless you want that.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/test-leadconnector.ts
 *   bash ./node_modules/.bin/tsx scripts/test-leadconnector.ts --book
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

const LC_BASE = 'https://services.leadconnectorhq.com';
const LC_VERSION = '2021-07-28';

// ---------------------------------------------------------------------------
// Inline AES-256-GCM decrypt (mirrors src/lib/credential-store.ts)
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';

function getKeyBuffer(): Buffer {
  const key =
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    'dev-encryption-key-32-bytes-long!';
  if (key.length === 32) return Buffer.from(key, 'utf-8');
  return crypto.createHash('sha256').update(key).digest();
}

function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Invalid ciphertext format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKeyBuffer(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf-8'
  );
}

// ---------------------------------------------------------------------------
// Test flow
// ---------------------------------------------------------------------------

async function main() {
  const shouldBook = process.argv.includes('--book');

  console.log('\n=== LeadConnector smoke test ===\n');

  // 1. Load credentials
  const account = await prisma.account.findFirst();
  if (!account) {
    console.error('❌ No Account row found in the database. Aborting.');
    process.exit(1);
  }
  console.log(`Account: ${account.id}`);

  const cred = await prisma.integrationCredential.findFirst({
    where: { accountId: account.id, provider: 'LEADCONNECTOR' }
  });
  if (!cred) {
    console.error('❌ No LEADCONNECTOR credential found for this account.');
    console.error(
      '   Save your API key + Calendar ID + Location ID in the Integrations settings page first.'
    );
    process.exit(1);
  }
  console.log(`Credential row: ${cred.id} (isActive: ${cred.isActive})`);

  // 2. Decrypt apiKey, read plaintext calendarId/locationId
  const raw = cred.credentials as Record<string, unknown>;
  let apiKey: string | undefined;
  try {
    const val = raw.apiKey;
    if (typeof val === 'string' && val.includes(':')) {
      apiKey = decrypt(val);
    } else if (typeof val === 'string') {
      apiKey = val;
    }
  } catch (err) {
    console.error('❌ Failed to decrypt apiKey:', err);
    process.exit(1);
  }
  const calendarId = raw.calendarId as string | undefined;
  const locationId = raw.locationId as string | undefined;

  console.log(`API key: ${apiKey ? '••••••' + apiKey.slice(-4) : 'MISSING'}`);
  console.log(`Calendar ID: ${calendarId || 'MISSING'}`);
  console.log(`Location ID: ${locationId || 'MISSING'}`);

  if (!apiKey || !calendarId || !locationId) {
    console.error('\n❌ Missing required credentials. Aborting.');
    process.exit(1);
  }

  // 3. Fetch availability (next 7 days)
  console.log('\n--- Step 1: Fetching availability ---');
  const now = Date.now();
  const sevenDaysOut = now + 7 * 24 * 60 * 60 * 1000;
  const qs = new URLSearchParams({
    startDate: String(now),
    endDate: String(sevenDaysOut),
    timezone: 'America/New_York'
  });
  const slotsUrl = `${LC_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots?${qs.toString()}`;
  console.log(`GET ${slotsUrl}`);

  const slotsRes = await fetch(slotsUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: LC_VERSION,
      'Content-Type': 'application/json'
    }
  });

  console.log(`Status: ${slotsRes.status} ${slotsRes.statusText}`);
  const slotsText = await slotsRes.text();

  if (!slotsRes.ok) {
    console.error('\n❌ free-slots request failed.');
    console.error('Response body:');
    console.error(slotsText.slice(0, 2000));
    process.exit(1);
  }

  let slotsJson: any;
  try {
    slotsJson = JSON.parse(slotsText);
  } catch {
    console.error('❌ Response was not valid JSON:');
    console.error(slotsText.slice(0, 500));
    process.exit(1);
  }

  console.log('\nRaw response keys:', Object.keys(slotsJson));

  // Flatten slots (mirrors calendar-adapter.ts behaviour)
  const parsedSlots: { start: string; end: string }[] = [];
  for (const [key, value] of Object.entries(slotsJson)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const v = value as any;
    const rawSlots: string[] = Array.isArray(v)
      ? v
      : Array.isArray(v?.slots)
        ? v.slots
        : [];
    for (const slotStart of rawSlots) {
      const start = new Date(slotStart);
      if (isNaN(start.getTime())) continue;
      const end = new Date(start.getTime() + 30 * 60_000);
      parsedSlots.push({ start: start.toISOString(), end: end.toISOString() });
    }
  }

  console.log(
    `\n✅ Parsed ${parsedSlots.length} free slot(s) across the next 7 days.`
  );
  if (parsedSlots.length === 0) {
    console.log('\n⚠️  Zero slots returned. This could mean:');
    console.log('    - No availability in the next 7 days');
    console.log('    - Calendar has no defined availability windows in GHL');
    console.log('    - Wrong Calendar ID (double-check in GHL settings)');
    console.log('    - Timezone mismatch');
    console.log('\nRaw JSON payload for inspection:');
    console.log(JSON.stringify(slotsJson, null, 2).slice(0, 2000));
  } else {
    console.log('\nFirst 5 slots (UTC):');
    parsedSlots.slice(0, 5).forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.start}  →  ${s.end}`);
    });
  }

  // 4. Optional: attempt a real booking
  if (!shouldBook) {
    console.log('\n--- Skipping booking test (pass --book to enable) ---');
    console.log(
      '\n✅ Availability check passed. LeadConnector is wired up correctly.'
    );
    await prisma.$disconnect();
    return;
  }

  if (parsedSlots.length === 0) {
    console.error('\n❌ Cannot test booking with zero available slots.');
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log('\n--- Step 2: Creating test contact ---');
  const testContact = {
    locationId,
    firstName: 'TEST',
    lastName: `Smoke-${Date.now()}`,
    email: `smoketest-${Date.now()}@example.com`,
    phone: '+15555550000',
    tags: ['smoke-test']
  };
  console.log(`POST ${LC_BASE}/contacts/`);
  console.log('Body:', JSON.stringify(testContact, null, 2));

  const contactRes = await fetch(`${LC_BASE}/contacts/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: LC_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(testContact)
  });
  console.log(`Status: ${contactRes.status} ${contactRes.statusText}`);
  const contactBody = await contactRes.text();
  if (!contactRes.ok) {
    console.error('\n❌ Contact creation failed:');
    console.error(contactBody.slice(0, 2000));
    await prisma.$disconnect();
    process.exit(1);
  }
  const contactJson = JSON.parse(contactBody);
  const contactId = contactJson.contact?.id || contactJson.id;
  console.log(`✅ Created contact: ${contactId}`);

  console.log('\n--- Step 3: Booking first available slot ---');
  const slot = parsedSlots[0];
  const apptBody = {
    calendarId,
    locationId,
    contactId,
    startTime: slot.start,
    endTime: slot.end,
    title: `SMOKE TEST — please delete`,
    appointmentStatus: 'confirmed',
    notes: 'Automated smoke test from test-leadconnector.ts',
    ignoreDateRange: false,
    toNotify: false
  };
  console.log(`POST ${LC_BASE}/calendars/events/appointments`);
  console.log('Body:', JSON.stringify(apptBody, null, 2));

  const apptRes = await fetch(`${LC_BASE}/calendars/events/appointments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: LC_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(apptBody)
  });
  console.log(`Status: ${apptRes.status} ${apptRes.statusText}`);
  const apptText = await apptRes.text();
  if (!apptRes.ok) {
    console.error('\n❌ Appointment booking failed:');
    console.error(apptText.slice(0, 2000));
    await prisma.$disconnect();
    process.exit(1);
  }
  const apptJson = JSON.parse(apptText);
  console.log(
    '\n✅ Booking succeeded:',
    JSON.stringify(apptJson, null, 2).slice(0, 1500)
  );
  console.log(
    '\n⚠️  Remember to delete the test appointment + test contact from GHL.'
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\n❌ Uncaught error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
