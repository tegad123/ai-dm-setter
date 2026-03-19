import { generateVoiceNote } from '@/lib/elevenlabs';
import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { text, conversationId } = body as {
      text?: string;
      conversationId?: string;
    };

    if (!text || text.trim().length === 0) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    // Generate voice note via account's ElevenLabs key (BYOK)
    const { audioUrl, duration } = await generateVoiceNote(
      auth.accountId,
      text
    );

    let messageId: string | undefined;

    // If conversationId provided, persist as a voice-note message
    if (conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, lead: { accountId: auth.accountId } }
      });

      if (!conversation) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }

      const message = await prisma.message.create({
        data: {
          conversationId,
          sender: 'AI',
          content: text,
          isVoiceNote: true,
          voiceNoteUrl: audioUrl
        }
      });

      // Update conversation lastMessageAt
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() }
      });

      messageId = message.id;
    }

    return NextResponse.json({
      audioUrl,
      duration,
      ...(messageId ? { messageId } : {})
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/voice/generate error:', error);
    return NextResponse.json(
      { error: 'Failed to generate voice note' },
      { status: 500 }
    );
  }
}
