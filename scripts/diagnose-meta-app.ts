/**
 * Query Meta's Graph API directly to see the app's status:
 *   - App mode (Live vs Development)
 *   - Business Verification status
 *   - Which permissions are in Live status vs Pending Review vs Approved-but-not-Live
 *   - Which features are enabled
 *
 * This uses the App Access Token (META_APP_ID|META_APP_SECRET) so it has
 * full visibility into the app's own configuration.
 *
 * Usage:
 *   bash ./node_modules/.bin/tsx scripts/diagnose-meta-app.ts
 */
import 'dotenv/config';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

async function main() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    console.error('META_APP_ID and META_APP_SECRET must be set in env');
    process.exit(1);
  }

  const appAccessToken = `${appId}|${appSecret}`;

  console.log(`\nApp ID: ${appId}\n`);

  // 1. Basic app info — including category, mode, business
  console.log('─── Probe 1: App Basic Info ───');
  const appRes = await fetch(
    `${GRAPH_API}/${appId}?fields=id,name,namespace,category,migrations,app_type,business&access_token=${appAccessToken}`
  );
  const appText = await appRes.text();
  try {
    const appData = JSON.parse(appText);
    if (appRes.ok) {
      console.log(JSON.stringify(appData, null, 2));
    } else {
      console.log(`HTTP ${appRes.status}:`, appText.slice(0, 800));
    }
  } catch {
    console.log('Raw:', appText.slice(0, 800));
  }

  // 2. Permissions — full list with their status
  console.log('\n─── Probe 2: App Permissions (live vs pending) ───');
  const permsRes = await fetch(
    `${GRAPH_API}/${appId}/permissions?access_token=${appAccessToken}`
  );
  const permsText = await permsRes.text();
  try {
    const permsData = JSON.parse(permsText);
    if (permsRes.ok && permsData.data) {
      console.log(`Found ${permsData.data.length} permissions:\n`);
      const targets = [
        'pages_show_list',
        'pages_messaging',
        'pages_manage_metadata',
        'pages_read_engagement',
        'instagram_basic',
        'instagram_manage_messages',
        'instagram_manage_comments',
        'public_profile'
      ];
      const byName = new Map<string, any>();
      for (const p of permsData.data) byName.set(p.permission, p);
      console.log('  Permission                    | Status');
      console.log('  ------------------------------|--------');
      for (const t of targets) {
        const row = byName.get(t);
        const status = row ? row.status : '(not in list)';
        console.log(`  ${t.padEnd(30)}| ${status}`);
      }
      console.log('\n  Full list:');
      for (const p of permsData.data) {
        console.log(`    ${p.permission}: ${p.status}`);
      }
    } else {
      console.log(`HTTP ${permsRes.status}:`, permsText.slice(0, 1000));
    }
  } catch {
    console.log('Raw:', permsText.slice(0, 1000));
  }

  // 3. App restrictions / mode
  console.log('\n─── Probe 3: App Restrictions ───');
  const restrictRes = await fetch(
    `${GRAPH_API}/${appId}?fields=restrictions,restrictive_data_filter_params&access_token=${appAccessToken}`
  );
  const restrictText = await restrictRes.text();
  console.log(restrictText.slice(0, 800));

  // 4. Try to read the app's current mode (live vs dev)
  // Note: this field requires app admin token, may fail with app access token
  console.log('\n─── Probe 4: Live Mode Check ───');
  const modeRes = await fetch(
    `${GRAPH_API}/${appId}?fields=is_in_dev_mode&access_token=${appAccessToken}`
  );
  const modeText = await modeRes.text();
  console.log(modeText.slice(0, 500));

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
