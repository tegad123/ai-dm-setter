/**
 * Smoke test for Resend transactional email setup.
 *
 * Verifies:
 *   1. RESEND_API_KEY is present
 *   2. EMAIL_FROM uses your verified domain
 *   3. The Resend API accepts the request and returns a message id
 *
 * Run:  pnpm tsx scripts/test-resend.ts <to-address>
 *
 * Example:
 *   pnpm tsx scripts/test-resend.ts tegad8@gmail.com
 */

import { config as loadEnv } from 'dotenv';
loadEnv();
import { sendEmail } from '../src/lib/email-notifier';

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: pnpm tsx scripts/test-resend.ts <to-address>');
    process.exit(2);
  }

  console.log(`From:    ${process.env.EMAIL_FROM ?? '(default)'}`);
  console.log(`To:      ${to}`);
  console.log(`Sending test email...\n`);

  const res = await sendEmail({
    to,
    subject: '[DMSetter test] Resend connection check',
    text:
      `This is a test of the DMSetter transactional email pipeline.\n\n` +
      `If you're seeing this, RESEND_API_KEY + EMAIL_FROM are wired up\n` +
      `and your verified domain is delivering mail correctly.\n\n` +
      `Sent at: ${new Date().toISOString()}`
  });

  console.log('Result:', res);

  if (res.ok) {
    console.log(`\n✓ Email accepted. Resend message id: ${res.id}`);
    console.log(`  Check inbox (+ spam) at ${to}`);
    process.exit(0);
  } else {
    console.error(`\n✗ Email failed: ${res.error ?? res.skipped}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
