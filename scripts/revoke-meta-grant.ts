/**
 * Nuclear option: revoke the active META credential's app grant on
 * Facebook's side, then delete the local credential row.
 *
 * Use this when Meta is silently caching an old grant and refusing to
 * re-prompt for newly-approved scopes. After running this, the user
 * clicks "Connect Meta" and gets a fresh consent dialog with all the
 * currently-requested scopes.
 *
 * DESTRUCTIVE: removes the entire app authorization for the user on
 * Meta's side, and deletes the local DB credential row. The user MUST
 * reconnect afterwards.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/revoke-meta-grant.ts
 */
import { PrismaClient } from '@prisma/client';
import { getCredentials, deleteCredentials } from '../src/lib/credential-store';

const prisma = new PrismaClient();

async function main() {
  const record = await prisma.integrationCredential.findFirst({
    where: { provider: 'META', isActive: true },
    include: { account: { select: { name: true, slug: true } } }
  });

  if (!record) {
    console.log('No active META credential found — nothing to revoke.');
    return;
  }

  console.log(`Account: ${record.account.name} (${record.account.slug})`);
  console.log(`Cred ID: ${record.id}`);

  const creds = await getCredentials(record.accountId, 'META');
  const token = creds?.accessToken;
  if (!token) {
    console.error('Could not decrypt access token.');
    process.exit(1);
  }

  // 1. Revoke ALL app permissions on Meta's side
  console.log('\nRevoking app grant on Facebook...');
  const revokeRes = await fetch(
    `https://graph.facebook.com/v21.0/me/permissions?access_token=${token}`,
    { method: 'DELETE' }
  );
  const revokeText = await revokeRes.text();
  if (revokeRes.ok) {
    console.log(`  ✓ Revoked: ${revokeText}`);
  } else {
    console.warn(
      `  ✗ Revoke failed (HTTP ${revokeRes.status}): ${revokeText.slice(0, 300)}`
    );
    console.warn('  Continuing with local cleanup anyway...');
  }

  // 2. Delete the local credential row
  console.log('\nDeleting local META credential...');
  await deleteCredentials(record.accountId, 'META');
  console.log('  ✓ Deleted local META credential');

  // 3. Also delete any INSTAGRAM credential (it shares the same token)
  const igRecord = await prisma.integrationCredential.findFirst({
    where: {
      accountId: record.accountId,
      provider: 'INSTAGRAM',
      isActive: true
    }
  });
  if (igRecord) {
    await deleteCredentials(record.accountId, 'INSTAGRAM');
    console.log('  ✓ Deleted local INSTAGRAM credential');
  }

  console.log(
    '\nDone. The user should now click "Connect Meta" on the integrations page.'
  );
  console.log(
    'They will see a FRESH Facebook consent dialog with all currently-requested scopes.'
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
