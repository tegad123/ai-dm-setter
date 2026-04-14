// ---------------------------------------------------------------------------
// migrate-daniel-to-scripts.ts
// ---------------------------------------------------------------------------
// One-time migration: creates a default Script for Daniel's account and
// maps his existing ScriptSlot bindings (voice notes, links, form data)
// to the new ScriptAction records.
//
// Usage: npx tsx scripts/migrate-daniel-to-scripts.ts
// ---------------------------------------------------------------------------

import { PrismaClient } from '@prisma/client';
import { seedDefaultScript } from '../prisma/seed-default-script';

const prisma = new PrismaClient();

async function main() {
  // 1. Find Daniel's account (search by name pattern)
  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { name: { contains: 'Daniel', mode: 'insensitive' } },
        { name: { contains: 'Dae', mode: 'insensitive' } }
      ]
    }
  });

  if (!account) {
    console.error(
      'Could not find Daniel/Dae account. Provide accountId as arg.'
    );
    const accountId = process.argv[2];
    if (!accountId) {
      console.error(
        'Usage: npx tsx scripts/migrate-daniel-to-scripts.ts [accountId]'
      );
      process.exit(1);
    }
    await migrateAccount(accountId);
    return;
  }

  console.log(`Found account: ${account.name} (${account.id})`);
  await migrateAccount(account.id);
}

async function migrateAccount(accountId: string) {
  // Check if already migrated
  const existingScript = await prisma.script.findFirst({
    where: { accountId }
  });
  if (existingScript) {
    console.log(
      `Account already has a script: ${existingScript.name} (${existingScript.id})`
    );
    console.log('Skipping seed. Proceeding to data mapping...');
  }

  // 2. Create default template if needed
  const scriptId =
    existingScript?.id || (await seedDefaultScript(accountId, prisma));
  console.log(`Script ID: ${scriptId}`);

  // 3. Fetch existing ScriptSlots
  const slots = await prisma.scriptSlot.findMany({
    where: { accountId },
    include: {
      boundVoiceNote: {
        select: { id: true, userLabel: true }
      }
    }
  });

  console.log(`Found ${slots.length} existing ScriptSlots`);

  // 4. Fetch all actions for the new script
  const actions = await prisma.scriptAction.findMany({
    where: { step: { scriptId } },
    include: {
      step: { select: { title: true, stepNumber: true } }
    },
    orderBy: [{ step: { stepNumber: 'asc' } }, { sortOrder: 'asc' }]
  });

  // 5. Map voice note bindings
  const vnSlots = slots.filter(
    (s) => s.slotType === 'voice_note' && s.boundVoiceNoteId
  );
  for (const slot of vnSlots) {
    // Find matching action by step/action context
    const matchingAction = actions.find(
      (a) => a.actionType === 'send_voice_note' && !a.voiceNoteId // Not yet bound
    );
    if (matchingAction && slot.boundVoiceNoteId) {
      await prisma.scriptAction.update({
        where: { id: matchingAction.id },
        data: { voiceNoteId: slot.boundVoiceNoteId }
      });
      console.log(
        `  Bound voice note "${slot.boundVoiceNote?.userLabel}" to Step ${matchingAction.step.stepNumber}: ${matchingAction.step.title}`
      );
    }
  }

  // 6. Map link URLs
  const linkSlots = slots.filter((s) => s.slotType === 'link' && s.url);
  for (const slot of linkSlots) {
    const matchingAction = actions.find(
      (a) =>
        (a.actionType === 'send_link' || a.actionType === 'send_video') &&
        !a.linkUrl // Not yet filled
    );
    if (matchingAction && slot.url) {
      await prisma.scriptAction.update({
        where: { id: matchingAction.id },
        data: { linkUrl: slot.url }
      });
      console.log(
        `  Mapped link "${slot.url}" to Step ${matchingAction.step.stepNumber}: ${matchingAction.step.title}`
      );
    }
  }

  // 7. Map form data
  const formSlots = slots.filter(
    (s) =>
      s.slotType === 'form' &&
      s.formValues &&
      typeof s.formValues === 'object' &&
      Object.keys(s.formValues as object).length > 0
  );
  if (formSlots.length > 0) {
    const forms = await prisma.scriptForm.findMany({
      where: { scriptId },
      include: { fields: { orderBy: { sortOrder: 'asc' } } }
    });

    for (const slot of formSlots) {
      const schema = slot.formSchema as {
        fields?: Array<{ field_id: string; label: string }>;
      } | null;
      const vals = slot.formValues as Record<string, string>;

      if (schema?.fields && vals) {
        // Try to match by form name or just use the first form
        const targetForm = forms[0]; // Simple mapping for now
        if (targetForm) {
          for (const schemaField of schema.fields) {
            const value = vals[schemaField.field_id];
            if (value) {
              // Find matching field by label similarity
              const targetField = targetForm.fields.find(
                (f) =>
                  f.fieldLabel
                    .toLowerCase()
                    .includes(schemaField.label.toLowerCase().slice(0, 10)) ||
                  schemaField.label
                    .toLowerCase()
                    .includes(f.fieldLabel.toLowerCase().slice(0, 10))
              );
              if (targetField) {
                await prisma.scriptFormField.update({
                  where: { id: targetField.id },
                  data: { fieldValue: value }
                });
                console.log(
                  `  Mapped form value "${schemaField.label}" = "${value.slice(0, 50)}..."`
                );
              }
            }
          }
        }
      }
    }
  }

  // 8. Activate the script
  await prisma.$transaction([
    prisma.script.updateMany({
      where: { accountId, isActive: true },
      data: { isActive: false }
    }),
    prisma.script.update({
      where: { id: scriptId },
      data: { isActive: true }
    })
  ]);

  console.log(`\nMigration complete. Script "${scriptId}" is now active.`);
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
