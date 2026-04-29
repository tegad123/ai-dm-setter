/* eslint-disable no-console */
// Recovery for Abdulahi (geography gate fired incorrectly on a 13-day-
// old conversation with human messages — pre-FIX 2026-04-29).
//
// Dry-run by default. Add --apply to actually write changes.
//
//   npx tsx scripts/recover-abdulahi.ts            # dry-run
//   npx tsx scripts/recover-abdulahi.ts --apply    # apply
//
// Reverts:
//   1. lead.geographyDisqualified = false
//   2. conversation.geographyGated = false, geographyCountry = null
//   3. lead.stage → lead.previousStage (whatever it was before the
//      transitionLeadStage call set it to UNQUALIFIED)
//   4. Remove the 'geography' tag from the lead
//
// Does NOT delete the AI exit message that was sent — Daniel needs to
// follow up manually. We log the exit message id for audit.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  const leads = await prisma.lead.findMany({
    where: {
      handle: { contains: 'abdulahi', mode: 'insensitive' },
      geographyDisqualified: true
    },
    include: {
      conversation: {
        select: {
          id: true,
          geographyGated: true,
          geographyCountry: true,
          aiActive: true,
          createdAt: true
        }
      },
      tags: { include: { tag: true } }
    }
  });

  if (leads.length === 0) {
    console.log(
      'No Abdulahi lead with geographyDisqualified=true found — nothing to recover.'
    );
    await prisma.$disconnect();
    return;
  }

  console.log(
    `Found ${leads.length} Abdulahi candidate(s). Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`
  );

  for (const lead of leads) {
    console.log(
      `── Lead ${lead.id} @${lead.handle} (${lead.name})` +
        `\n   stage=${lead.stage}  previousStage=${lead.previousStage ?? '(none)'}` +
        `\n   geographyDisqualified=${lead.geographyDisqualified}` +
        `\n   conv=${lead.conversation?.id ?? '(none)'}  geographyGated=${lead.conversation?.geographyGated} country=${lead.conversation?.geographyCountry ?? '-'} aiActive=${lead.conversation?.aiActive}`
    );

    const geoTag = lead.tags.find(
      (t) => t.tag.name.toLowerCase() === 'geography'
    );
    console.log(
      `   geography tag: ${geoTag ? `present (LeadTag.id=${geoTag.id})` : 'absent'}`
    );

    // Find the AI exit message we sent (so we can log it for audit).
    if (lead.conversation) {
      const exitMsg = await prisma.message.findFirst({
        where: {
          conversationId: lead.conversation.id,
          sender: 'AI',
          content: { contains: 'mentorship program is currently only' }
        },
        orderBy: { timestamp: 'desc' },
        select: { id: true, timestamp: true, content: true }
      });
      if (exitMsg) {
        console.log(
          `   exit message: id=${exitMsg.id} sentAt=${exitMsg.timestamp.toISOString()}`
        );
      } else {
        console.log('   exit message: not found in DB');
      }
    }

    const targetStage = lead.previousStage;
    if (!targetStage) {
      console.log(
        '   ⚠ previousStage is null — cannot auto-revert lead.stage. Will leave as-is.'
      );
    } else {
      console.log(`   plan: revert stage ${lead.stage} → ${targetStage}`);
    }

    if (!APPLY) {
      console.log('   (dry-run — no changes applied)\n');
      continue;
    }

    // 1. Lead — clear flag, revert stage if we have a previousStage.
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        geographyDisqualified: false,
        ...(targetStage
          ? {
              stage: targetStage,
              previousStage: lead.stage,
              stageEnteredAt: new Date()
            }
          : {})
      }
    });
    if (targetStage) {
      await prisma.leadStageTransition.create({
        data: {
          leadId: lead.id,
          fromStage: lead.stage,
          toStage: targetStage,
          transitionedBy: 'system',
          reason: 'recover-abdulahi: geography gate fired in error pre-FIX'
        }
      });
    }

    // 2. Conversation — clear gate flags. Leave aiActive as-is (the
    //    operator will toggle if they want).
    if (lead.conversation) {
      await prisma.conversation.update({
        where: { id: lead.conversation.id },
        data: {
          geographyGated: false,
          geographyCountry: null
        }
      });
    }

    // 3. Remove the geography tag from the lead.
    if (geoTag) {
      await prisma.leadTag.delete({ where: { id: geoTag.id } });
    }

    console.log('   ✓ recovered\n');
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
