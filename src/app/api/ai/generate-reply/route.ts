import prisma from '@/lib/prisma';
import { generateReply } from '@/lib/ai-engine';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const body = await request.json();
    const { conversationId } = body;

    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 }
      );
    }

    // Fetch conversation with messages and lead context, scoped to account
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        lead: { accountId: auth.accountId }
      },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' }
        },
        lead: true
      }
    });

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    if (!conversation.aiActive) {
      return NextResponse.json(
        { error: 'AI is paused for this conversation (human override active)' },
        { status: 403 }
      );
    }

    const { lead, messages } = conversation;

    // Build lead context from the database record
    const leadContext = {
      leadName: lead.name,
      handle: lead.handle,
      platform: lead.platform,
      status: lead.stage,
      triggerType: lead.triggerType,
      triggerSource: lead.triggerSource,
      qualityScore: lead.qualityScore
    };

    // Generate the AI reply scoped to this conversation's persona.
    const result = await generateReply(
      auth.accountId,
      conversation.personaId,
      messages,
      leadContext
    );

    return NextResponse.json({
      reply: result.reply,
      shouldVoiceNote: result.shouldVoiceNote,
      qualityScore: result.qualityScore,
      suggestedDelay: result.suggestedDelay,
      suggestedTag: result.suggestedTag,
      suggestedTags: result.suggestedTags,
      stage: result.stage,
      stageConfidence: result.stageConfidence,
      sentimentScore: result.sentimentScore,
      systemPromptVersion: result.systemPromptVersion
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to generate AI reply:', error);
    return NextResponse.json(
      { error: 'Failed to generate AI reply' },
      { status: 500 }
    );
  }
}
