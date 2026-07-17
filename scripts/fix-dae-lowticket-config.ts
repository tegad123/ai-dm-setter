// Leak #3 remediation + engine-config corrections for the daetradez
// low-ticket persona (cmpy59zz30002ju04v1bjdwzw). Aligns the persona's
// engine config with its no-qualification / no-booking website funnel:
//
//   1. minimumCapitalRequired: 1000 -> null
//      THE R24 driver. Disarms every engine capital channel: the R24 prompt
//      rule, the script-branch inject, the "before we lock anything in"
//      fallback (the live leak), the call-pitch-before-capital hard fail,
//      the passive capital listener, Case E, and all $497 downsell routes.
//   2. allowEarlyFinancialScreening: true -> false
//      Single consumer is the early-financial-screening prompt carve-out.
//   3. closerName: 'Anthony' -> null
//      With promptConfig.callHandoff archived (below), the call-handoff
//      identity block and closer scope rule drop out of the prompt entirely.
//   4. promptConfig.typeformUrl / homeworkUrl / callHandoff -> archived
//      under promptConfig._highTicketArchived (reversible). Removes the
//      booking/typeform URL lines and the CALL HOMEWORK section from the
//      prompt — the remaining call/booking-flavored contamination.
//
// Prints full before/after for the audit evidence. Reversible: restore from
// _highTicketArchived + the printed before-state.
//
// Usage: npx tsx scripts/fix-dae-lowticket-config.ts            # apply
//        npx tsx scripts/fix-dae-lowticket-config.ts --verify   # read-only
//        npx tsx scripts/fix-dae-lowticket-config.ts --revert   # restore archived

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

const PERSONA_ID = 'cmpy59zz30002ju04v1bjdwzw';
const ARCHIVE_KEY = '_highTicketArchived';
const KEYS_TO_ARCHIVE = ['typeformUrl', 'homeworkUrl', 'callHandoff'] as const;

async function retry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}

function summarize(persona: {
  minimumCapitalRequired: number | null;
  allowEarlyFinancialScreening: boolean;
  skipR24ScriptInject: boolean;
  closerName: string | null;
  promptConfig: unknown;
}) {
  const pc = (persona.promptConfig ?? {}) as Record<string, unknown>;
  console.log(
    '  minimumCapitalRequired      =',
    persona.minimumCapitalRequired
  );
  console.log(
    '  allowEarlyFinancialScreening =',
    persona.allowEarlyFinancialScreening
  );
  console.log('  skipR24ScriptInject          =', persona.skipR24ScriptInject);
  console.log('  closerName                   =', persona.closerName ?? 'null');
  for (const k of KEYS_TO_ARCHIVE) {
    console.log(
      `  promptConfig.${k}`.padEnd(31),
      '=',
      pc[k] === undefined ? '(absent)' : JSON.stringify(pc[k])?.slice(0, 80)
    );
  }
  console.log(
    '  promptConfig.disableLeadStageProgression =',
    pc['disableLeadStageProgression'] ?? '(unset)'
  );
  const archived = pc[ARCHIVE_KEY] as Record<string, unknown> | undefined;
  console.log(
    '  promptConfig._highTicketArchived keys    =',
    archived ? Object.keys(archived).join(', ') : '(none)'
  );
}

async function main() {
  const mode = process.argv[2];

  const persona = await retry(() =>
    prisma.aIPersona.findUnique({
      where: { id: PERSONA_ID },
      select: {
        id: true,
        personaName: true,
        minimumCapitalRequired: true,
        allowEarlyFinancialScreening: true,
        skipR24ScriptInject: true,
        closerName: true,
        promptConfig: true
      }
    })
  );
  if (!persona) throw new Error('persona not found: ' + PERSONA_ID);

  console.log(`persona ${persona.id} "${persona.personaName}"`);
  console.log('\n=== BEFORE ===');
  summarize(persona);

  if (mode === '--verify') {
    await prisma.$disconnect();
    return;
  }

  const pc = (
    persona.promptConfig &&
    typeof persona.promptConfig === 'object' &&
    !Array.isArray(persona.promptConfig)
      ? { ...(persona.promptConfig as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  if (mode === '--revert') {
    const archived = (pc[ARCHIVE_KEY] ?? {}) as Record<string, unknown>;
    for (const k of KEYS_TO_ARCHIVE) {
      if (archived[k] !== undefined) pc[k] = archived[k];
    }
    if (archived['__assetLinksBookingLink'] !== undefined) {
      const assets = (pc['assetLinks'] ?? {}) as Record<string, unknown>;
      assets['bookingLink'] = archived['__assetLinksBookingLink'];
      pc['assetLinks'] = assets;
    }
    delete pc[ARCHIVE_KEY];
    const restoredCloser =
      typeof archived['__closerName'] === 'string'
        ? (archived['__closerName'] as string)
        : 'Anthony';
    await prisma.$executeRaw`
      UPDATE "AIPersona"
      SET "minimumCapitalRequired" = 1000,
          "allowEarlyFinancialScreening" = true,
          "closerName" = ${restoredCloser},
          "promptConfig" = ${JSON.stringify(pc)}::jsonb
      WHERE id = ${PERSONA_ID}
    `;
    console.log('\nREVERTED to high-ticket config.');
  } else {
    const archived = (pc[ARCHIVE_KEY] ?? {}) as Record<string, unknown>;
    for (const k of KEYS_TO_ARCHIVE) {
      if (pc[k] !== undefined) {
        archived[k] = pc[k];
        delete pc[k];
      }
    }
    if (persona.closerName) archived['__closerName'] = persona.closerName;
    pc[ARCHIVE_KEY] = archived;

    await prisma.$executeRaw`
      UPDATE "AIPersona"
      SET "minimumCapitalRequired" = NULL,
          "allowEarlyFinancialScreening" = false,
          "closerName" = NULL,
          "promptConfig" = ${JSON.stringify(pc)}::jsonb
      WHERE id = ${PERSONA_ID}
    `;
    console.log('\nAPPLIED low-ticket engine config.');
  }

  const after = await retry(() =>
    prisma.aIPersona.findUnique({
      where: { id: PERSONA_ID },
      select: {
        minimumCapitalRequired: true,
        allowEarlyFinancialScreening: true,
        skipR24ScriptInject: true,
        closerName: true,
        promptConfig: true
      }
    })
  );
  console.log('\n=== AFTER ===');
  if (after) summarize(after);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
