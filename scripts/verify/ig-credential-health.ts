// Instagram credential health, read-only, never prints tokens.
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/ig-credential-health.ts [accountId]
// For every INSTAGRAM credential: stored ids vs the id Meta delivers in
// webhook entry.id (live /me?fields=user_id), subscription state, token
// validity. With an accountId: also checks that account's OpenAI/Anthropic
// keys and Meta page token.
//
// Instagram has THREE ids per account:
//   igUserId / me.id       = app-scoped OAuth id (used for OUTBOUND sends)
//   me.user_id             = PROFESSIONAL id (17841…) = webhook entry.id for IG-Login accounts
//   instagram_business_account.id (17841…) = page-linked id (only when linked to a FB Page)
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
import crypto from 'crypto';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
const KEY =
  process.env.CREDENTIAL_ENCRYPTION_KEY || 'dev-encryption-key-32-bytes-long!';
const keyBuf =
  KEY.length === 32
    ? Buffer.from(KEY, 'utf-8')
    : crypto.createHash('sha256').update(KEY).digest();
function decrypt(c: string) {
  const [iv, tag, enc] = c.split(':');
  const d = crypto.createDecipheriv(
    'aes-256-gcm',
    keyBuf,
    Buffer.from(iv, 'hex')
  );
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString(
    'utf-8'
  );
}
function tokenOf(raw: any): string | undefined {
  if (typeof raw === 'string') return JSON.parse(decrypt(raw)).accessToken;
  if (raw?.accessToken) {
    try {
      return decrypt(raw.accessToken);
    } catch {
      return raw.accessToken;
    }
  }
  if (raw?.apiKey) {
    try {
      return decrypt(raw.apiKey);
    } catch {
      return raw.apiKey;
    }
  }
  return undefined;
}
async function retry<T>(fn: () => Promise<T>, t = 12): Promise<T> {
  let l: unknown;
  for (let i = 0; i < t; i++) {
    try {
      return await fn();
    } catch (e) {
      l = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw l;
}
(async () => {
  const onlyAccount = process.argv[2];
  const rows = await retry(() =>
    prisma.integrationCredential.findMany({
      where: {
        provider: 'INSTAGRAM',
        isActive: true,
        ...(onlyAccount ? { accountId: onlyAccount } : {})
      },
      select: {
        accountId: true,
        metadata: true,
        credentials: true,
        account: {
          select: {
            name: true,
            awayModeInstagram: true,
            generateOnlyInstagram: true
          }
        }
      }
    })
  );
  for (const r of rows) {
    const m: any = r.metadata;
    console.log(
      `\n=== ${r.account.name} (${r.accountId}) @${m?.username} | awayIG=${r.account.awayModeInstagram} generateOnlyIG=${r.account.generateOnlyInstagram}`
    );
    const stored = [
      m?.pageId,
      m?.igUserId,
      m?.instagramAccountId,
      m?.igBusinessAccountId,
      m?.igProfessionalAccountId
    ]
      .filter(Boolean)
      .map(String);
    console.log('  stored ids:', stored.join(', '));
    const token = tokenOf(r.credentials);
    if (!token) {
      console.log('  no access token');
      continue;
    }
    const me = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=id,user_id,username,account_type&access_token=${encodeURIComponent(token)}`
    );
    const meJ: any = await me.json();
    if (meJ.error) {
      console.log(
        `  TOKEN INVALID (Meta code ${meJ.error.code}): ${String(meJ.error.message).slice(0, 100)} → needs reconnect`
      );
      continue;
    }
    console.log(
      `  live /me: id=${meJ.id} user_id=${meJ.user_id} account_type=${meJ.account_type}`
    );
    const subs = await fetch(
      `https://graph.instagram.com/v21.0/me/subscribed_apps?access_token=${encodeURIComponent(token)}`
    );
    const subsJ: any = await subs.json();
    console.log(
      '  subscribed_apps:',
      JSON.stringify(subsJ.data ?? subsJ.error?.message)
    );
    const delivered = String(meJ.user_id ?? meJ.id);
    console.log(
      `  webhook entry.id would be ${delivered} → ${stored.includes(delivered) ? 'MATCHES a stored id ✅' : 'MATCHES NOTHING ❌ (inbound DMs silently dropped — run scripts/backfill-ig-professional-id.ts)'}`
    );
  }
  if (onlyAccount) {
    for (const provider of ['OPENAI', 'ANTHROPIC', 'META'] as const) {
      const c = await retry(() =>
        prisma.integrationCredential.findFirst({
          where: { accountId: onlyAccount, provider, isActive: true },
          select: { credentials: true, metadata: true }
        })
      );
      if (!c) {
        console.log(`\n${provider}: no credential`);
        continue;
      }
      const tok = tokenOf(c.credentials);
      if (!tok) {
        console.log(`\n${provider}: no key`);
        continue;
      }
      let status = 0,
        note = '';
      if (provider === 'OPENAI') {
        const r = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${tok}` }
        });
        status = r.status;
      } else if (provider === 'ANTHROPIC') {
        const r = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': tok, 'anthropic-version': '2023-06-01' }
        });
        status = r.status;
      } else {
        const r = await fetch(
          `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(tok)}`
        );
        const j: any = await r.json();
        status = r.status;
        note = r.ok
          ? `${j.name} ${j.id}`
          : String(j.error?.message).slice(0, 80);
      }
      console.log(`\n${provider}: HTTP ${status} ${note}`);
    }
  }
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
