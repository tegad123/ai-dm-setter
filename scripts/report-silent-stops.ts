import 'dotenv/config';
import prisma from '../src/lib/prisma';

type SilentStopCandidate = {
  conversationId: string;
  leadId: string;
  accountId: string;
  leadName: string;
  leadHandle: string;
  leadStage: string;
  lastLeadMessageAt: Date;
};

async function main() {
  const rows = await prisma.$queryRaw<SilentStopCandidate[]>`
    WITH latest_message AS (
      SELECT DISTINCT ON (m."conversationId")
        m."conversationId",
        m."sender",
        m."timestamp"
      FROM "Message" m
      WHERE m."timestamp" > NOW() - INTERVAL '60 days'
      ORDER BY m."conversationId", m."timestamp" DESC
    )
    SELECT
      c."id" AS "conversationId",
      l."id" AS "leadId",
      l."accountId" AS "accountId",
      l."name" AS "leadName",
      l."handle" AS "leadHandle",
      l."stage"::text AS "leadStage",
      lm."timestamp" AS "lastLeadMessageAt"
    FROM latest_message lm
    JOIN "Conversation" c ON c."id" = lm."conversationId"
    JOIN "Lead" l ON l."id" = c."leadId"
    WHERE lm."sender" = 'LEAD'
      AND lm."timestamp" < NOW() - INTERVAL '30 minutes'
      AND l."stage"::text NOT IN (
        'BOOKED',
        'SHOWED',
        'CLOSED_WON',
        'CLOSED_LOST',
        'GHOSTED',
        'NO_SHOWED'
      )
    ORDER BY lm."timestamp" DESC
  `;

  const byAccount = new Map<string, number>();
  for (const row of rows) {
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + 1);
  }

  console.log('Silent stop diagnostic report only. No rows mutated.');
  console.log(`Candidates found: ${rows.length}`);
  console.log(
    JSON.stringify(
      {
        byAccount: Object.fromEntries(byAccount),
        sample: rows.slice(0, 25).map((row) => ({
          conversationId: row.conversationId,
          leadId: row.leadId,
          accountId: row.accountId,
          handle: row.leadHandle,
          name: row.leadName,
          stage: row.leadStage,
          lastLeadMessageAt: row.lastLeadMessageAt.toISOString()
        }))
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
