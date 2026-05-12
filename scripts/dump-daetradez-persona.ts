/* eslint-disable no-console */
// Dump every script-shaped field on the daetradez persona to a markdown file.
// Read-only.

import { writeFileSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';

function section(label: string, value: unknown): string {
  const heading = `\n## ${label}\n\n`;
  if (value === null || value === undefined) return heading + '_(null)_\n';
  if (typeof value === 'string') {
    return heading + '```\n' + value + '\n```\n';
  }
  return heading + '```json\n' + JSON.stringify(value, null, 2) + '\n```\n';
}

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, slug: true, name: true }
  });
  if (!account) {
    console.error('No daetradez account.');
    process.exit(1);
  }

  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: account.id },
    orderBy: { updatedAt: 'desc' }
  });
  if (!persona) {
    console.error('No persona found for daetradez.');
    process.exit(1);
  }

  const out: string[] = [];
  out.push(`# Daetradez Persona — Sales Script Snapshot\n`);
  out.push(
    `- **Account:** ${account.id} (${account.slug} / ${account.name})\n` +
      `- **Persona:** ${persona.id} ("${persona.personaName}", active=${persona.isActive})\n` +
      `- **Updated:** ${persona.updatedAt.toISOString()}\n` +
      `- **Context updated:** ${persona.contextUpdatedAt?.toISOString() ?? 'null'}\n` +
      `- **rawScript:** ${persona.rawScript ? `${persona.rawScript.length} chars` : 'null (operator never pasted a single-block script — populated structured fields instead)'}\n`
  );

  out.push(section('rawScript', persona.rawScript));
  out.push(section('rawScriptFileName', persona.rawScriptFileName));
  out.push(section('systemPrompt', persona.systemPrompt));
  out.push(section('styleAnalysis', persona.styleAnalysis));
  out.push(section('qualificationFlow', persona.qualificationFlow));
  out.push(section('objectionHandling', persona.objectionHandling));
  out.push(section('promptConfig', persona.promptConfig));
  out.push(section('customPhrases', persona.customPhrases));
  out.push(section('downsellConfig', persona.downsellConfig));
  out.push(section('financialWaterfall', persona.financialWaterfall));
  out.push(section('knowledgeAssets', persona.knowledgeAssets));
  out.push(section('proofPoints', persona.proofPoints));
  out.push(section('preCallSequence', persona.preCallSequence));
  out.push(section('noShowProtocol', persona.noShowProtocol));
  out.push(section('voiceNoteDecisionPrompt', persona.voiceNoteDecisionPrompt));
  out.push(section('qualityScoringPrompt', persona.qualityScoringPrompt));
  out.push(section('activeCampaignsContext', persona.activeCampaignsContext));
  out.push(section('outOfScopeTopics', persona.outOfScopeTopics));

  const outPath = join(
    process.cwd(),
    'tmp',
    `daetradez-persona-${persona.updatedAt.toISOString().replace(/[:.]/g, '-')}.md`
  );
  // Make sure tmp/ exists (mkdir -p)
  const fs = await import('fs');
  fs.mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
  writeFileSync(outPath, out.join('\n'));

  console.log(`Wrote ${out.join('').length} chars to ${outPath}`);
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
