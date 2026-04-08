/**
 * Diagnose the live Meta token: print granted permissions and probe the
 * endpoints the OAuth callback uses, so we can tell whether:
 *   1. pages_read_engagement / pages_manage_metadata are actually granted
 *   2. /me/accounts now returns Page details (the happy path)
 *   3. /{pageId}?fields=name,access_token,... succeeds (Fallback 3 path)
 *
 * This uses the SAME decryption path as the app, so it tells us exactly what
 * the app would see at runtime.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/diagnose-meta-token.ts
 */
import { PrismaClient } from '@prisma/client';
import { getCredentials } from '../src/lib/credential-store';

const prisma = new PrismaClient();
const GRAPH_API = 'https://graph.facebook.com/v21.0';

async function main() {
  // 1. Find the META credential record
  const record = await prisma.integrationCredential.findFirst({
    where: { provider: 'META', isActive: true },
    include: { account: { select: { name: true, slug: true } } }
  });

  if (!record) {
    console.error('No active META credential found.');
    process.exit(1);
  }

  console.log(`\nAccount: ${record.account.name} (${record.account.slug})`);
  console.log(`Cred ID: ${record.id}`);
  console.log(`Stored metadata:`);
  console.log(JSON.stringify(record.metadata, null, 2));

  // 2. Decrypt the access token
  const creds = await getCredentials(record.accountId, 'META');
  if (!creds?.accessToken) {
    console.error('No accessToken in credential record.');
    process.exit(1);
  }
  const token = creds.accessToken;
  const meta = record.metadata as any;
  const pageId = meta.pageId;

  // 3. Probe /me/permissions — what scopes does Meta actually report?
  console.log('\n─── Probe 1: /me/permissions ───');
  const permsRes = await fetch(
    `${GRAPH_API}/me/permissions?access_token=${token}`
  );
  const permsText = await permsRes.text();
  try {
    const permsData = JSON.parse(permsText);
    if (permsData.data) {
      const granted = permsData.data
        .filter((p: any) => p.status === 'granted')
        .map((p: any) => p.permission);
      const declined = permsData.data
        .filter((p: any) => p.status !== 'granted')
        .map((p: any) => `${p.permission}:${p.status}`);
      console.log('  Granted:', granted.join(', '));
      if (declined.length > 0) {
        console.log('  Declined:', declined.join(', '));
      }
      // Check our newly-approved scopes specifically
      const has = (s: string) => granted.includes(s);
      console.log('\n  Critical scopes:');
      console.log(
        `    pages_show_list:        ${has('pages_show_list') ? '✓' : '✗'}`
      );
      console.log(
        `    pages_messaging:        ${has('pages_messaging') ? '✓' : '✗'}`
      );
      console.log(
        `    pages_manage_metadata:  ${has('pages_manage_metadata') ? '✓' : '✗'}`
      );
      console.log(
        `    pages_read_engagement:  ${has('pages_read_engagement') ? '✓' : '✗'}`
      );
      console.log(
        `    instagram_basic:        ${has('instagram_basic') ? '✓' : '✗'}`
      );
      console.log(
        `    instagram_manage_messages: ${has('instagram_manage_messages') ? '✓' : '✗'}`
      );
    } else {
      console.log('  Unexpected response:', permsText.slice(0, 500));
    }
  } catch {
    console.log('  Raw:', permsText.slice(0, 500));
  }

  // 4. Probe /me/accounts — does the happy path work now?
  console.log('\n─── Probe 2: /me/accounts ───');
  const acctRes = await fetch(
    `${GRAPH_API}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${token}`
  );
  const acctText = await acctRes.text();
  try {
    const acctData = JSON.parse(acctText);
    console.log(`  HTTP ${acctRes.status}`);
    if (acctData.data && acctData.data.length > 0) {
      console.log(`  Pages returned: ${acctData.data.length}`);
      for (const p of acctData.data) {
        console.log(
          `    - id=${p.id}  name="${p.name}"  ig=${p.instagram_business_account?.id ?? 'none'}  has_page_token=${!!p.access_token}`
        );
      }
    } else {
      console.log('  ⚠ EMPTY — happy path is broken, fallback would trigger');
      console.log('  Raw:', acctText.slice(0, 800));
    }
  } catch {
    console.log('  Raw:', acctText.slice(0, 800));
  }

  // 5. Probe /{pageId}?fields=... — does Fallback 3 work now?
  console.log(
    `\n─── Probe 3: /${pageId}?fields=name,access_token,instagram_business_account ───`
  );
  const pageRes = await fetch(
    `${GRAPH_API}/${pageId}?fields=id,name,access_token,instagram_business_account&access_token=${token}`
  );
  const pageText = await pageRes.text();
  try {
    const pageData = JSON.parse(pageText);
    console.log(`  HTTP ${pageRes.status}`);
    if (pageRes.ok && pageData.id) {
      console.log(`  ✓ Page details fetched:`);
      console.log(`    id:   ${pageData.id}`);
      console.log(`    name: ${pageData.name}`);
      console.log(`    has_page_access_token: ${!!pageData.access_token}`);
      console.log(
        `    instagram_business_account: ${pageData.instagram_business_account?.id ?? 'none'}`
      );
    } else {
      console.log('  ✗ Failed:', pageText.slice(0, 500));
    }
  } catch {
    console.log('  Raw:', pageText.slice(0, 500));
  }

  // 6. Probe debug_token — what does Meta say about this token?
  console.log('\n─── Probe 4: /debug_token ───');
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (appId && appSecret) {
    const dbgRes = await fetch(
      `${GRAPH_API}/debug_token?input_token=${token}&access_token=${appId}|${appSecret}`
    );
    const dbgText = await dbgRes.text();
    try {
      const dbgData = JSON.parse(dbgText);
      console.log(`  type:    ${dbgData.data?.type}`);
      console.log(`  app_id:  ${dbgData.data?.app_id}`);
      console.log(`  user_id: ${dbgData.data?.user_id}`);
      console.log(
        `  expires_at: ${dbgData.data?.expires_at ? new Date(dbgData.data.expires_at * 1000).toISOString() : 'never'}`
      );
      console.log(`  is_valid: ${dbgData.data?.is_valid}`);
      console.log(`  scopes:`, dbgData.data?.scopes);
      if (dbgData.data?.granular_scopes) {
        console.log(`  granular_scopes:`);
        for (const gs of dbgData.data.granular_scopes) {
          console.log(
            `    ${gs.scope} → target_ids=${JSON.stringify(gs.target_ids ?? 'all')}`
          );
        }
      }
    } catch {
      console.log('  Raw:', dbgText.slice(0, 800));
    }
  } else {
    console.log('  (skipped — META_APP_ID / META_APP_SECRET not in env)');
  }

  console.log();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
