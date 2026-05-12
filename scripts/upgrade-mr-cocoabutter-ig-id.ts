/* eslint-disable no-console */
// One-shot: resolve and upgrade Lead.platformUserId for mr.cocoabutter
// from the handle to the real Instagram numeric user ID via ManyChat
// REST. After this runs, the silent-stop heartbeat can ship the AI's
// first reply on this conversation (currently rejected by
// hasUsablePlatformRecipient because the stored platformUserId is a
// non-numeric handle).

import prisma from '../src/lib/prisma';
import { resolveAndUpgradeInstagramNumericId } from '../src/lib/manychat-resolve-ig-id';

const ACCOUNT_SLUG = 'daetradez2003';
const HANDLE = 'mr.cocoabutter';
const KNOWN_SUBSCRIBER_ID = '1245431958';

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: ACCOUNT_SLUG },
    select: { id: true }
  });
  if (!account) throw new Error(`account ${ACCOUNT_SLUG} not found`);

  const lead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      handle: { equals: HANDLE, mode: 'insensitive' }
    },
    select: { id: true, handle: true, platformUserId: true }
  });
  if (!lead) {
    console.error(`No lead found for @${HANDLE}`);
    process.exit(1);
  }
  console.log(
    `Lead ${lead.id} @${lead.handle} platformUserId=${lead.platformUserId}`
  );

  const resolved = await resolveAndUpgradeInstagramNumericId({
    accountId: account.id,
    leadId: lead.id,
    existingPlatformUserId: lead.platformUserId,
    incomingInstagramUserId: KNOWN_SUBSCRIBER_ID,
    manyChatSubscriberId: KNOWN_SUBSCRIBER_ID
  });
  console.log(`Resolved IG numeric ID: ${resolved ?? 'NULL (lookup failed)'}`);

  const after = await prisma.lead.findUnique({
    where: { id: lead.id },
    select: { platformUserId: true }
  });
  console.log(`After: platformUserId=${after?.platformUserId}`);
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
