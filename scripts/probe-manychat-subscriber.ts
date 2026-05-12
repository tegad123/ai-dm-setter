/* eslint-disable no-console */
// Probe ManyChat's /fb/subscriber/getInfo to see what fields come back
// for an IG subscriber. Specifically looking for a numeric IG user ID
// (PSID / IGSID) so we can use it as Meta's IG Send API recipient.

import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';

const SUBSCRIBER_ID = '1245431958'; // mr.cocoabutter's ManyChat subscriber ID

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: 'daetradez2003' },
    select: { id: true }
  });
  if (!account) throw new Error('account not found');

  const creds = await getCredentials(account.id, 'MANYCHAT');
  if (!creds?.apiKey) throw new Error('no ManyChat API key configured');
  console.log('Have ManyChat API key (length:', creds.apiKey.length, ')');

  const url = `https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${SUBSCRIBER_ID}`;
  console.log('GET', url);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      Accept: 'application/json'
    }
  });
  console.log('HTTP', res.status);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(text);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
