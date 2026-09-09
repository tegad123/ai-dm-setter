// Toggle generate-only shadow mode for a workspace + platform.
//
// Generate-only = AI generates and the gates judge every new lead on that
// platform, the reply is shown as a suggestion, and NOTHING is delivered
// (enforced at the send choke point). Pair with Away Mode OFF for the
// platform so auto-send stays off; the script warns if Away Mode is ON.
//
// Usage:
//   DATABASE_URL=$PROD_DATABASE_URL NODE_PATH=$PWD/node_modules \
//     npx tsx scripts/set-generate-only.ts <accountId> <INSTAGRAM|FACEBOOK> <on|off>

import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const [accountId, platformRaw, stateRaw] = process.argv.slice(2);
  const platform = (platformRaw ?? '').toUpperCase();
  const state = (stateRaw ?? '').toLowerCase();
  if (
    !accountId ||
    (platform !== 'INSTAGRAM' && platform !== 'FACEBOOK') ||
    (state !== 'on' && state !== 'off')
  ) {
    console.error(
      'usage: set-generate-only.ts <accountId> <INSTAGRAM|FACEBOOK> <on|off>'
    );
    process.exit(2);
  }
  const field =
    platform === 'INSTAGRAM' ? 'generateOnlyInstagram' : 'generateOnlyFacebook';
  const awayField =
    platform === 'INSTAGRAM' ? 'awayModeInstagram' : 'awayModeFacebook';

  const before = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      name: true,
      generateOnlyInstagram: true,
      generateOnlyFacebook: true,
      awayModeInstagram: true,
      awayModeFacebook: true,
      defaultAiActive: true
    }
  });
  if (!before) throw new Error(`account ${accountId} not found`);

  const updated = await prisma.account.update({
    where: { id: accountId },
    data:
      platform === 'INSTAGRAM'
        ? { generateOnlyInstagram: state === 'on' }
        : { generateOnlyFacebook: state === 'on' },
    select: {
      generateOnlyInstagram: true,
      generateOnlyFacebook: true,
      awayModeInstagram: true,
      awayModeFacebook: true,
      defaultAiActive: true
    }
  });
  console.log(
    `${before.name} (${accountId}) ${platform} generate-only: ${String((before as any)[field])} → ${String((updated as any)[field])}`
  );
  if (state === 'on' && (updated as any)[awayField]) {
    console.warn(
      `WARNING: ${awayField} is ON — auto-send is still enabled on ${platform}. ` +
        `Turn Away Mode OFF for ${platform} so replies stay suggestions (the send choke point blocks delivery either way).`
    );
  }
  if (state === 'on' && updated.defaultAiActive === false) {
    console.warn(
      'WARNING: defaultAiActive is false — new leads will still start with AI off, so nothing will generate.'
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
