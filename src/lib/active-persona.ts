// Audit F4.2 transitional helper.
//
// Resolves the persona to assign when CREATING a Conversation, using the
// same non-deterministic `findFirst({where:{accountId, isActive:true}})`
// pattern that pre-migration code applied implicitly via the assumption
// "the account has one active persona". Now that Conversation.personaId
// is NOT NULL, every create call site must pass an explicit value — this
// helper preserves current behavior so Phase 1 ships isolated from the
// caller refactor.
//
// **Phase 3 (audit F3.2) will delete every call to this helper.** The
// upstream webhook / API caller knows which persona the inbound event
// belongs to (via the recipient IG account ID for Instagram, the page ID
// for Facebook, the form ID for Typeform, the operator's UI selection
// for the manual /api/leads POST). That signal will be threaded through
// to the create site, and personaId becomes a parameter, not a lookup.
//
// Until then: do NOT use this helper for read paths (prompt assembly,
// gate evaluation, training retrieval). Those paths must already know
// the persona via Conversation.personaId.

import prisma from '@/lib/prisma';

export async function resolveActivePersonaIdForCreate(
  accountId: string
): Promise<string> {
  const active = await prisma.aIPersona.findFirst({
    where: { accountId, isActive: true },
    select: { id: true },
    orderBy: { updatedAt: 'desc' }
  });
  if (active) return active.id;

  // Transitional accounts can have personas configured but not yet
  // marked active (mid-onboarding). Fall back to any persona in the
  // account so a webhook arriving before activation still has a
  // valid foreign key.
  const any = await prisma.aIPersona.findFirst({
    where: { accountId },
    select: { id: true },
    orderBy: { updatedAt: 'desc' }
  });
  if (any) return any.id;

  throw new Error(
    `[active-persona] Account ${accountId} has no AIPersona — cannot create a Conversation. ` +
      `Provision a persona before accepting inbound events for this account.`
  );
}
