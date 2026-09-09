// ---------------------------------------------------------------------------
// generate-only.ts — per-platform "generate but never send" shadow mode.
// ---------------------------------------------------------------------------
// Tega 2026-09-08: Daniel does not want the AI live on his Instagram leads,
// and tegaumukoro_ alone cannot fill a clean shadow window. With
// Account.generateOnly{Instagram,Facebook} ON (and Away Mode OFF) every new
// lead on that platform runs the full pipeline — generation, quality gate,
// egress-gate shadow row — and surfaces as a suggestion, while NOTHING is
// delivered. The "never" is enforced in two places:
//   1. the automated senders (keepalive / follow-up / stale-bubble crons)
//      skip generate-only conversations up front (no error noise), and
//   2. the physical send choke point (shadowEgressCheck) BLOCKS any
//      non-operator send for a generate-only platform regardless of the
//      authoritative flag — so no code path can deliver by accident.
// Operator-initiated sends (manual reply, approved suggestion) still go out.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

export type GenerateOnlyAccount = {
  generateOnlyInstagram?: boolean | null;
  generateOnlyFacebook?: boolean | null;
};

export function resolvePlatformGenerateOnly(
  account: GenerateOnlyAccount | null | undefined,
  platform: string | null | undefined
): boolean {
  if (platform === 'INSTAGRAM') return account?.generateOnlyInstagram ?? false;
  if (platform === 'FACEBOOK') return account?.generateOnlyFacebook ?? false;
  return false;
}

/**
 * Whether a NEW inbound conversation starts with AI ON. Away Mode is the
 * normal opt-in; generate-only also turns AI on (for generation) while
 * auto-send stays gated by `shouldAutoSendReply` (awayMode || override),
 * so the lead lands in suggestion mode. Ongoing conversations always start
 * with AI off (operator-controlled thread).
 */
export function computeInboundAiActive(args: {
  isOngoing: boolean;
  awayMode: boolean;
  generateOnly: boolean;
  defaultAiActive: boolean | null | undefined;
}): boolean {
  if (args.isOngoing) return false;
  return (args.awayMode || args.generateOnly) && (args.defaultAiActive ?? true);
}

/** DB-backed check for the crons / gate. Never throws (defaults to false). */
export async function isGenerateOnlyForAccountPlatform(
  accountId: string,
  platform: string | null | undefined
): Promise<boolean> {
  if (platform !== 'INSTAGRAM' && platform !== 'FACEBOOK') return false;
  try {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { generateOnlyInstagram: true, generateOnlyFacebook: true }
    });
    return resolvePlatformGenerateOnly(account, platform);
  } catch (err) {
    console.error(
      '[generate-only] account lookup failed (treating as NOT generate-only):',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
