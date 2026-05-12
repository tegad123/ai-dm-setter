/* eslint-disable no-console */
// Probe several variants of ManyChat's subscriber-by-username endpoint
// to find one that's actually live. The current
// `findSubscriberByInstagramUsername` path returns 404 for every
// handle we try.

import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';

const HANDLE = 'mr.cocoabutter';

async function tryEndpoint(apiKey: string, path: string) {
  const url = `https://api.manychat.com${path}`;
  console.log(`\n--- ${path} ---`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 400));
}

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: 'daetradez2003' },
    select: { id: true }
  });
  if (!account) throw new Error('account not found');
  const creds = await getCredentials(account.id, 'MANYCHAT');
  if (!creds?.apiKey) throw new Error('no key');

  const variants = [
    `/fb/subscriber/findByInstagramUsername?ig_username=${HANDLE}`,
    `/fb/subscriber/findByName?name=${HANDLE}`,
    `/fb/subscriber/findByCustomField?field_id=ig_username&field_value=${HANDLE}`,
    `/fb/subscriber/findBySocialId?social_id=${HANDLE}`,
    `/fb/subscriber/findByUsername?username=${HANDLE}`,
    `/fb/subscriber/getInfoByUsername?username=${HANDLE}`,
    `/fb/subscriber/getInfo?username=${HANDLE}`
  ];
  for (const v of variants) {
    await tryEndpoint(creds.apiKey, v);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
