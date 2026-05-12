/* eslint-disable no-console */
import prisma from '../src/lib/prisma';

const HANDLES = [
  'mr.cocoabutter',
  'tegaumukoro_',
  'arielbuenaflorumpacan',
  'christiaan99__',
  '_ibran_ash89',
  'officeenrich',
  'ww.w.davidl',
  'iam.ebere',
  'teerawat_prasertkun',
  'imarap_nickol',
  'kofiadu262'
];

async function main() {
  const leads = await prisma.lead.findMany({
    where: { handle: { in: HANDLES, mode: 'insensitive' } },
    select: {
      id: true,
      handle: true,
      platformUserId: true,
      conversation: { select: { id: true, manyChatFiredAt: true } }
    }
  });
  for (const l of leads) {
    const isNumeric = /^\d{12,}$/.test((l.platformUserId || '').trim());
    console.log(
      `@${l.handle}: platformUserId="${l.platformUserId}" usable=${isNumeric} convo=${l.conversation?.id ?? 'none'}`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
