import { requireAuth, AuthError } from '@/lib/auth-guard';
import { generateVoiceProfile } from '@/lib/voice-profile-generator';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/settings/voice-profile — get current voice profile (from stored promptConfig)
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Try to read cached profile from persona promptConfig
    const { default: prisma } = await import('@/lib/prisma');
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true },
      select: { promptConfig: true }
    });

    const config = persona?.promptConfig as Record<string, unknown> | null;
    const voiceProfile = config?.voiceProfile ?? null;

    return NextResponse.json({ voiceProfile });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/voice-profile error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch voice profile' },
      { status: 500 }
    );
  }
}

// POST /api/settings/voice-profile — generate a new voice profile from conversation history
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const profile = await generateVoiceProfile(auth.accountId);

    // Store in persona promptConfig
    const { default: prisma } = await import('@/lib/prisma');
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true }
    });

    if (persona) {
      const existingConfig =
        (persona.promptConfig as Record<string, unknown>) || {};
      const updatedConfig = {
        ...existingConfig,
        voiceProfile: JSON.parse(JSON.stringify(profile)),
        toneDescription:
          existingConfig.toneDescription || profile.styleDescription
      };
      await prisma.aIPersona.update({
        where: { id: persona.id },
        data: {
          promptConfig: updatedConfig
        }
      });
    }

    return NextResponse.json({ voiceProfile: profile });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/settings/voice-profile error:', error);
    return NextResponse.json(
      { error: 'Failed to generate voice profile' },
      { status: 500 }
    );
  }
}
