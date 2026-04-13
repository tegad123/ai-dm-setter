#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// Migration: Convert free-text trigger conditions to structured triggers
// ---------------------------------------------------------------------------
// Idempotent: skips items where legacyTriggerText is already populated.
// Uses Claude Haiku for conversion. Sets status to NEEDS_REVIEW.
// ---------------------------------------------------------------------------

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const HAIKU_MODEL = 'claude-haiku-4-20250414';

const CONVERSION_PROMPT = `Convert this voice note trigger condition into structured triggers.

ORIGINAL TEXT:
"{TEXT}"

AVAILABLE TRIGGER TYPES:

1. stage_transition — for triggers tied to pipeline stage changes
   { "type": "stage_transition", "from_stage": "any" or one of [NEW_LEAD, ENGAGED, QUALIFYING, QUALIFIED, CALL_PROPOSED, BOOKED, SHOWED, NO_SHOWED, RESCHEDULED, CLOSED_WON, CLOSED_LOST, UNQUALIFIED, GHOSTED, NURTURE], "to_stage": one of the same stages }

2. content_intent — for triggers tied to specific lead message intents
   { "type": "content_intent", "intent": one of [price_objection, time_concern, skepticism_or_scam_concern, past_failure, complexity_concern, need_to_think, not_interested, ready_to_buy, budget_question, experience_question, timeline_question] }

3. conversational_move — for contextual/situational triggers
   { "type": "conversational_move", "suggested_moments": ["moment description 1"], "required_pipeline_stages": ["STAGE1", "STAGE2"], "cooldown": { "type": "messages", "value": 5 } }

INSTRUCTIONS:
- Return a JSON array of 1-3 triggers that best represent the original text.
- If the text clearly maps to a stage transition or content intent, prefer those.
- If it's vague or contextual, use conversational_move with appropriate stages.
- For conversational_move, choose the most relevant pipeline stages and default cooldown to { "type": "messages", "value": 5 }.
- Return ONLY a JSON array, no explanation.

OUTPUT: [...]`;

async function migrateVoiceNoteTriggers() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY env var required for migration');
    process.exit(1);
  }

  // Find all items with trigger text but not yet migrated
  const items = await prisma.voiceNoteLibraryItem.findMany({
    where: {
      triggerConditionsNatural: { not: null },
      legacyTriggerText: null // Not yet migrated
    },
    select: {
      id: true,
      triggerConditionsNatural: true,
      userLabel: true
    }
  });

  console.log(`Found ${items.length} voice notes to migrate.`);

  if (items.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const item of items) {
    const text = item.triggerConditionsNatural?.trim();
    if (!text) {
      // Skip empty trigger text
      await prisma.voiceNoteLibraryItem.update({
        where: { id: item.id },
        data: { legacyTriggerText: '' }
      });
      continue;
    }

    console.log(
      `\nMigrating: ${item.userLabel || item.id} — "${text.slice(0, 80)}..."`
    );

    try {
      const prompt = CONVERSION_PROMPT.replace('{TEXT}', text);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 500,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        throw new Error(`Haiku API error: ${response.status}`);
      }

      const data = await response.json();
      const responseText = data?.content?.[0]?.text || '';

      // Parse JSON array
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('Could not find JSON array in response');
      }

      const rawTriggers = JSON.parse(jsonMatch[0]);

      // Validate (dynamic import to avoid top-level ESM issues)
      const { validateTriggers, generateTriggerDescription } = await import(
        '../src/lib/voice-note-triggers'
      );
      const triggers = validateTriggers(rawTriggers);
      const triggerDescription = generateTriggerDescription(triggers);

      // Update the record
      await prisma.voiceNoteLibraryItem.update({
        where: { id: item.id },
        data: {
          legacyTriggerText: text,
          triggers: triggers as unknown as any,
          triggerDescription,
          status: 'NEEDS_REVIEW'
        }
      });

      console.log(`  ✓ Migrated with ${triggers.length} trigger(s)`);
      console.log(`    Description: ${triggerDescription}`);
      success++;
    } catch (err) {
      console.error(
        `  ✗ Failed: ${err instanceof Error ? err.message : String(err)}`
      );
      // Still copy legacy text even on failure so we don't retry forever
      await prisma.voiceNoteLibraryItem.update({
        where: { id: item.id },
        data: { legacyTriggerText: text }
      });
      failed++;
    }
  }

  console.log(`\nMigration complete: ${success} succeeded, ${failed} failed.`);
}

migrateVoiceNoteTriggers()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
