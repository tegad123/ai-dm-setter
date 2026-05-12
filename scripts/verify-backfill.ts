/* eslint-disable no-console */
// Verify backfill — for each conversation we flipped, report whether the
// heartbeat has produced an AI reply yet.

import prisma from '../src/lib/prisma';

const CONV_IDS = [
  'cmnp9r1mh000ml304dj6dz1a3', // mr.cocoabutter
  'cmor1x0tq000fl50441u428k4', // mulu_lu.8
  'cmor39iib000nl504pjq9afbs', // arielbuenaflorumpacan
  'cmor3p1m9000vl504yhu3eqi2', // christiaan99__
  'cmor6mziv0003jo045wopec5h', // philip.pkfr
  'cmor839xq000bjo04304x6hxg', // _ibran_ash89
  'cmor87h59000jjo0438caynvl', // officeenrich
  'cmor8h2ed000rjo04uily0n75', // ww.w.davidl
  'cmorbifjw0003l504uja2infv', // iam.ebere
  'cmor0oirg0003l5044g75ldb2', // tegaumukoro_
  'cmorglnjw0003jy04bbnt5znb', // teerawat_prasertkun
  'cmorgve4b0003l404doiozd9c', // imarap_nickol
  'cmori4ygk0003jv04w5ucexu2', // kofiadu262
  'cmorib9lf000bjv04mprlzn09' // dominicianpappi
];

async function main() {
  const convs = await prisma.conversation.findMany({
    where: { id: { in: CONV_IDS } },
    select: {
      id: true,
      aiActive: true,
      awaitingAiResponse: true,
      awaitingSince: true,
      lastSilentStopAt: true,
      lead: { select: { handle: true, stage: true } },
      messages: {
        orderBy: { timestamp: 'desc' },
        take: 2,
        select: { sender: true, content: true, timestamp: true }
      }
    }
  });

  let replied = 0;
  let pending = 0;
  for (const c of convs) {
    const latest = c.messages[0];
    const aiReplied = latest && latest.sender !== 'LEAD';
    if (aiReplied) replied += 1;
    else pending += 1;
    const handle = c.lead?.handle ?? '?';
    const status = aiReplied ? '✓ AI REPLIED' : '⏳ pending';
    const latestStr = latest
      ? `${latest.sender}: "${latest.content.slice(0, 70)}"`
      : 'none';
    console.log(
      `${status}  ${c.id} (@${handle})  awaiting=${c.awaitingAiResponse} aiActive=${c.aiActive} silentStop=${c.lastSilentStopAt?.toISOString() ?? 'null'} latest=${latestStr}`
    );
  }
  console.log('─────────────────────────────────────────────');
  console.log(`replied: ${replied}/${convs.length}`);
  console.log(`pending: ${pending}/${convs.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
