/* eslint-disable no-console */
// Dump the master AI Setter system prompt as it lives in
// `src/lib/ai-prompts.ts`. Two outputs:
//   1) The raw template with `{{placeholder}}` variables intact —
//      this is the literal source-of-truth template applied to every
//      account.
//   2) A "rendered for daetradez" version with the placeholders
//      substituted using daetradez's actual persona config — this is
//      essentially what the AI sees on every turn for daetradez.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';
import { buildDynamicSystemPrompt } from '../src/lib/ai-prompts';

const SRC = join(process.cwd(), 'src/lib/ai-prompts.ts');
const OUT_DIR = join(process.cwd(), 'tmp');

function extractMasterTemplate(): string {
  const file = readFileSync(SRC, 'utf-8');
  const start = file.indexOf('const MASTER_PROMPT_TEMPLATE = `');
  if (start < 0) throw new Error('MASTER_PROMPT_TEMPLATE not found');
  const open = file.indexOf('`', start) + 1;
  const close = file.indexOf('\n`;', open);
  if (close < 0) throw new Error('closing backtick for template not found');
  return file.slice(open, close);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const raw = extractMasterTemplate();
  const rawPath = join(OUT_DIR, 'master-prompt-template.md');
  writeFileSync(rawPath, raw);
  console.log(`Wrote raw template (${raw.length} chars) to ${rawPath}`);

  // Render for daetradez. Pull the persona, build the prompt as the
  // AI engine would on a real turn for that account.
  const account = await prisma.account.findFirst({
    where: { slug: 'daetradez2003' },
    select: { id: true }
  });
  if (!account) throw new Error('daetradez account not found');
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: account.id, isActive: true },
    select: { id: true, personaName: true }
  });
  if (!persona) throw new Error('no active daetradez persona');

  // Minimal LeadContext stub so the prompt builder runs. Most fields
  // affect specific blocks (booking, geography); for a structural
  // dump, basic identity fields are enough.
  const rendered = await buildDynamicSystemPrompt(account.id, persona.id, {
    leadName: 'Test Lead',
    handle: 'test_lead',
    platform: 'instagram',
    triggerContext: 'followed your account',
    followsBack: false,
    followerCount: 0
  } as any);
  const renderedPath = join(OUT_DIR, 'master-prompt-rendered-daetradez.md');
  writeFileSync(renderedPath, rendered);
  console.log(
    `Wrote daetradez-rendered prompt (${rendered.length} chars) to ${renderedPath}`
  );
  console.log('');
  console.log(`Persona used: ${persona.id} (${persona.personaName})`);
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
