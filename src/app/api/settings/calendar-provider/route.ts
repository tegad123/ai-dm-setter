import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';

// The four calendar providers the booking adapter understands, by their
// IntegrationProvider key. `null` clears the explicit choice and lets the
// adapter fall back to its precedence order.
const VALID_CALENDAR_PROVIDERS = [
  'GOOGLE_CALENDAR',
  'LEADCONNECTOR',
  'CALENDLY',
  'CALCOM'
] as const;
type CalendarProvider = (typeof VALID_CALENDAR_PROVIDERS)[number];

function isValid(value: unknown): value is CalendarProvider {
  return (
    typeof value === 'string' &&
    VALID_CALENDAR_PROVIDERS.includes(value as CalendarProvider)
  );
}

/**
 * PUT /api/settings/calendar-provider
 * Body: { provider: 'GOOGLE_CALENDAR' | 'LEADCONNECTOR' | 'CALENDLY' | 'CALCOM' | null }
 *
 * Sets the account's active booking calendar. Rejects a provider that isn't
 * actually connected so the AI can never be pointed at an empty calendar.
 */
export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json().catch(() => ({}));
    const { provider } = body as { provider?: unknown };

    // Allow clearing the selection (fall back to precedence)
    if (provider === null) {
      await prisma.account.update({
        where: { id: auth.accountId },
        data: { activeCalendarProvider: null }
      });
      return NextResponse.json({ activeCalendarProvider: null });
    }

    if (!isValid(provider)) {
      return NextResponse.json(
        {
          error: `Invalid provider. Must be one of: ${VALID_CALENDAR_PROVIDERS.join(
            ', '
          )} (or null)`
        },
        { status: 400 }
      );
    }

    // Only allow selecting a provider that is actually connected.
    const connected = await prisma.integrationCredential.findUnique({
      where: {
        accountId_provider: { accountId: auth.accountId, provider }
      },
      select: { isActive: true }
    });
    if (!connected?.isActive) {
      return NextResponse.json(
        {
          error: `${provider} is not connected. Connect it before making it the active booking calendar.`
        },
        { status: 400 }
      );
    }

    await prisma.account.update({
      where: { id: auth.accountId },
      data: { activeCalendarProvider: provider }
    });

    return NextResponse.json({ activeCalendarProvider: provider });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/calendar-provider error:', error);
    return NextResponse.json(
      { error: 'Failed to set active calendar provider' },
      { status: 500 }
    );
  }
}
