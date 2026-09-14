// Review bundle for an operator: every AI suggestion generated on a platform
// for an account since a given time, one list, with the conversation ID, the
// lead's last message the draft answered, the draft itself, the script step
// the engine was on, and the egress gate verdict on that draft. Read-only.
//
// Run (prod):
//   DATABASE_URL="$PROD_DATABASE_URL" NODE_PATH=$PWD/node_modules npx tsx scripts/verify/ig-suggestion-review.ts \
//     --account <accountId> [--platform INSTAGRAM] [--since 2026-09-11T05:41:00Z] [--out /path/bundle.md]
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import prisma from '@/lib/prisma';
import {
  collectPostWaitContents,
  matchPostWaitCopy
} from '@/lib/state-machine/egress-guards';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const one = (s: string | null | undefined, n = 400) =>
  (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function main() {
  const accountId = arg('account');
  if (!accountId) throw new Error('--account <accountId> required');
  const platform = (arg('platform') ?? 'INSTAGRAM') as 'INSTAGRAM' | 'FACEBOOK';
  const since = new Date(arg('since') ?? '2026-09-11T05:41:00Z');
  const out = arg('out');

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      name: true,
      generateOnlyInstagram: true,
      generateOnlyFacebook: true
    }
  });
  if (!account) throw new Error('account not found');

  const suggestions = await prisma.aISuggestion.findMany({
    where: {
      accountId,
      generatedAt: { gte: since },
      conversation: { lead: { platform } }
    },
    orderBy: { generatedAt: 'asc' },
    select: {
      id: true,
      conversationId: true,
      generatedAt: true,
      responseText: true,
      messageBubbles: true,
      capitalOutcome: true,
      qualityGateScore: true,
      qualityGateAttempts: true,
      wasSelected: true,
      dismissed: true,
      manuallyApproved: true,
      conversation: {
        select: {
          currentScriptStep: true,
          source: true,
          lead: { select: { name: true } },
          messages: {
            orderBy: { timestamp: 'asc' },
            select: {
              sender: true,
              content: true,
              timestamp: true,
              platformMessageId: true
            }
          }
        }
      }
    }
  });

  // The Wait-boundary guard runs per bubble at the physical send, which
  // generate-only never reaches, so compute its verdict offline with the
  // guard's own pure functions against the script step the engine was on.
  const script = await prisma.script.findFirst({
    where: { accountId, isActive: true },
    select: {
      steps: {
        select: {
          stepNumber: true,
          actions: {
            select: { actionType: true, content: true, sortOrder: true }
          },
          branches: {
            select: {
              actions: {
                select: { actionType: true, content: true, sortOrder: true }
              }
            }
          }
        }
      }
    }
  });
  const stepByNumber = new Map(
    (script?.steps ?? []).map((st) => [st.stepNumber, st])
  );
  const postWaitFor = (stepNumber: number | null) => {
    const out: string[] = [];
    for (const n of [stepNumber ?? 1, (stepNumber ?? 1) - 1]) {
      const st = stepByNumber.get(n);
      if (st) out.push(...collectPostWaitContents(st));
    }
    return out;
  };

  const shadow = await prisma.egressShadowLog.findMany({
    where: { accountId, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: {
      conversationId: true,
      createdAt: true,
      machineAllow: true,
      machineReason: true,
      sendPath: true,
      draftPreview: true
    }
  });

  // Gate rows are written per BUBBLE (draftPreview = the bubble text). Match a
  // draft's bubbles to the rows written for its conversation within 3 minutes
  // after generation; a held bubble is reported on that bubble.
  const norm = (t: string) =>
    t.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  const rowsFor = (convId: string, at: Date) =>
    shadow.filter(
      (s) =>
        s.conversationId === convId &&
        s.createdAt >= at &&
        s.createdAt.getTime() - at.getTime() < 3 * 60e3
    );
  const verdictForBubble = (convId: string, at: Date, bubble: string) => {
    const rows = rowsFor(convId, at);
    const nb = norm(bubble);
    return (
      rows.find((r) => r.draftPreview && norm(r.draftPreview) === nb) ?? null
    );
  };
  const verdictFor = (convId: string, at: Date) => {
    const rows = rowsFor(convId, at);
    return rows.find((r) => !r.machineAllow) ?? rows[0] ?? null;
  };

  const lines: string[] = [];
  lines.push(`# ${platform} suggestion review, ${account.name}`);
  lines.push('');
  lines.push(
    `Window: since ${since.toISOString()} to ${new Date().toISOString()}. Generate-only ${platform === 'INSTAGRAM' ? account.generateOnlyInstagram : account.generateOnlyFacebook ? 'ON' : 'OFF'}: every draft below was generated and stored, none were delivered by the AI.`
  );
  lines.push('');
  const delivered = suggestions.filter((s) => s.wasSelected).length;
  const convCount = new Set(suggestions.map((s) => s.conversationId)).size;
  const bubblesOf = (s: (typeof suggestions)[number]) =>
    Array.isArray(s.messageBubbles)
      ? (s.messageBubbles as unknown[]).map((b) =>
          typeof b === 'string' ? b : one(JSON.stringify(b))
        )
      : [s.responseText];
  const waitHeld = (
    s: (typeof suggestions)[number],
    bubble: string,
    index: number
  ) => {
    const postWait = postWaitFor(s.conversation.currentScriptStep);
    if (!postWait.length || !matchPostWaitCopy(bubble, postWait)) return false;
    const lastBefore = [...s.conversation.messages]
      .reverse()
      .find((m) => m.timestamp <= s.generatedAt);
    // Blocked when we already spoke and the lead has not answered yet: a later
    // bubble in the same group, or a draft generated right after our own turn.
    return (
      index > 0 || lastBefore?.sender === 'AI' || lastBefore?.sender === 'HUMAN'
    );
  };
  const blocked = suggestions.filter((s) => {
    const v = verdictFor(s.conversationId, s.generatedAt);
    if (v && !v.machineAllow) return true;
    return bubblesOf(s).some((b, i) => waitHeld(s, b, i));
  }).length;
  lines.push(
    `Totals: ${suggestions.length} drafts across ${convCount} conversations. Drafts with at least one bubble the gate held at delivery: ${blocked}. Delivered by AI: ${delivered}.`
  );
  lines.push('');
  lines.push(
    "Note on multi-bubble drafts: the AI writes the whole step at once; at delivery the Wait-boundary gate stops after the first question and the later bubbles wait for the lead's answer. Bubbles marked HELD AT DELIVERY would not have gone out in that turn."
  );
  lines.push('');
  lines.push(
    'How to read each row: the lead line is the last thing the lead said before the draft; the draft is what the AI would have sent; step is the script step the engine was on; verdict is what the egress gate said about that exact draft.'
  );
  lines.push('');
  lines.push(
    'Mark any draft you would NOT have sent with its number, e.g. "reject 12, 40, 41: reason".'
  );
  lines.push('');

  let n = 0;
  let lastConv = '';
  for (const s of suggestions) {
    n++;
    const c = s.conversation;
    const leadBefore = [...c.messages]
      .reverse()
      .find((m) => m.sender === 'LEAD' && m.timestamp <= s.generatedAt);
    const bubbles = bubblesOf(s);
    const v = verdictFor(s.conversationId, s.generatedAt);
    if (s.conversationId !== lastConv) {
      lines.push('');
      lines.push(
        `## ${c.lead.name ?? 'unknown'} | conversation ${s.conversationId} | source ${c.source ?? '-'}`
      );
      lastConv = s.conversationId;
    }
    lines.push('');
    lines.push(
      `**${n}.** ${s.generatedAt.toISOString()} | step ${c.currentScriptStep ?? '-'} | verdict ${v ? (v.machineAllow ? 'ALLOW' : `HOLD ${v.machineReason ?? ''}`) : 'no gate row'}${s.capitalOutcome ? ` | capital ${s.capitalOutcome}` : ''}`
    );
    lines.push(
      `- lead: ${leadBefore ? `"${one(leadBefore.content, 300)}"` : '(no lead message before this draft)'}`
    );
    bubbles.forEach((b, i) => {
      const bv = verdictForBubble(s.conversationId, s.generatedAt, b);
      const tag =
        bv && !bv.machineAllow
          ? ` [HELD AT DELIVERY: ${bv.machineReason}]`
          : waitHeld(s, b, i)
            ? " [HELD AT DELIVERY: WAIT_BOUNDARY, waits for the lead's answer]"
            : '';
      lines.push(`- draft: "${one(b, 600)}"${tag}`);
    });
  }

  const text = lines.join('\n') + '\n';
  if (out) {
    writeFileSync(out, text);
    console.log(
      `wrote ${out}: ${suggestions.length} drafts, ${convCount} conversations, ${blocked} would-hold`
    );
  } else {
    process.stdout.write(text);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
