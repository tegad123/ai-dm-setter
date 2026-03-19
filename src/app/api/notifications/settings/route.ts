/**
 * Notification Preferences API
 * GET  — Return current notification settings (defaults for now)
 * PATCH — Accept partial updates (logged, actual email sending is future work)
 */

import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ─── Types ──────────────────────────────────────────────

interface PushSettings {
  callBooked: boolean;
  hotLead: boolean;
  humanOverride: boolean;
  noShow: boolean;
  closedDeal: boolean;
}

interface EmailSettings {
  dailySummary: boolean;
  weeklyReport: boolean;
}

interface NotificationSettings {
  push: PushSettings;
  email: EmailSettings;
}

// ─── In-Memory Store ────────────────────────────────────
// Maps userId -> settings. Falls back to defaults if not set.
// In production this would live in a DB column (e.g. User.notificationSettings JSON).

const DEFAULT_SETTINGS: NotificationSettings = {
  push: {
    callBooked: true,
    hotLead: true,
    humanOverride: true,
    noShow: true,
    closedDeal: true
  },
  email: {
    dailySummary: true,
    weeklyReport: true
  }
};

const userSettings: Map<string, NotificationSettings> = new Map();

function getSettingsForUser(userId: string): NotificationSettings {
  return userSettings.get(userId) ?? structuredClone(DEFAULT_SETTINGS);
}

// ─── GET ────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    // Use the authenticated user's ID instead of requiring a query param
    const settings = getSettingsForUser(auth.userId);

    return NextResponse.json({ userId: auth.userId, settings });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch notification settings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch notification settings' },
      { status: 500 }
    );
  }
}

// ─── PATCH ──────────────────────────────────────────────

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const body = await request.json();
    const { settings: partialSettings } = body as {
      settings?: Partial<{
        push: Partial<PushSettings>;
        email: Partial<EmailSettings>;
      }>;
    };

    if (!partialSettings) {
      return NextResponse.json(
        { error: 'settings object is required in the request body' },
        { status: 400 }
      );
    }

    // Use the authenticated user's ID
    const current = getSettingsForUser(auth.userId);

    const updated: NotificationSettings = {
      push: {
        ...current.push,
        ...(partialSettings.push ?? {})
      },
      email: {
        ...current.email,
        ...(partialSettings.email ?? {})
      }
    };

    // Persist in memory
    userSettings.set(auth.userId, updated);

    console.log(
      `[NotificationSettings] Updated for user ${auth.userId}:`,
      JSON.stringify(updated)
    );

    return NextResponse.json({
      userId: auth.userId,
      settings: updated,
      message: 'Settings updated successfully'
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to update notification settings:', error);
    return NextResponse.json(
      { error: 'Failed to update notification settings' },
      { status: 500 }
    );
  }
}
