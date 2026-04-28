/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import prisma from '../src/lib/prisma';

async function main() {
  const a = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, slug: true }
  });
  if (!a) {
    console.log('no daetradez account');
    return;
  }
  console.log('account', a);

  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: a.id, isActive: true },
    select: {
      id: true,
      multiBubbleEnabled: true,
      promptConfig: true,
      systemPrompt: true,
      tone: true,
      personaName: true
    }
  });
  console.log(
    'persona.multiBubbleEnabled =',
    persona?.multiBubbleEnabled,
    'systemPrompt=',
    persona?.systemPrompt?.slice(0, 60),
    'tone=',
    persona?.tone
  );
  if (
    persona?.promptConfig &&
    typeof persona.promptConfig === 'object' &&
    persona.promptConfig !== null
  ) {
    const cfg = persona.promptConfig as Record<string, unknown>;
    console.log('promptConfig.multiBubble*=', {
      multiBubbleEnabled: cfg.multiBubbleEnabled,
      bubbleStyle: cfg.bubbleStyle
    });
  }

  const creds = await prisma.integrationCredential.findMany({
    where: { accountId: a.id },
    select: {
      provider: true,
      isActive: true,
      metadata: true
    }
  });
  for (const c of creds) {
    const md = c.metadata as Record<string, unknown> | null;
    console.log(
      `cred provider=${c.provider} active=${c.isActive} model=${md?.model ?? '-'} ${
        md ? Object.keys(md).join(',') : ''
      }`
    );
  }

  const recent = await prisma.aISuggestion.findMany({
    where: { accountId: a.id },
    orderBy: { generatedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      responseText: true,
      messageBubbles: true,
      bubbleCount: true,
      modelUsed: true,
      generatedAt: true
    }
  });
  for (const s of recent) {
    const bubbles = Array.isArray(s.messageBubbles)
      ? s.messageBubbles.length
      : 'null';
    const text =
      s.responseText.length > 140
        ? s.responseText.slice(0, 140) + '…'
        : s.responseText;
    console.log(
      `${s.generatedAt.toISOString()} model=${s.modelUsed ?? '?'} bubbles=${bubbles} count=${s.bubbleCount}\n  text: ${text}`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
