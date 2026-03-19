import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

interface SeedMessage {
  sender: 'AI' | 'LEAD' | 'HUMAN';
  content: string;
  stage?: string;
  stageConfidence?: number;
  timestamp?: string;
}

interface SeedConversation {
  leadName: string;
  leadHandle: string;
  platform: 'INSTAGRAM' | 'FACEBOOK';
  outcome: string;
  leadIntentTag?: string;
  messages: SeedMessage[];
}

function outcomeToLeadStatus(outcome: string): string {
  switch (outcome) {
    case 'BOOKED':
      return 'BOOKED';
    case 'UNQUALIFIED_REDIRECT':
      return 'UNQUALIFIED';
    case 'LEFT_ON_READ':
      return 'GHOSTED';
    case 'RESISTANT_EXIT':
      return 'TRUST_OBJECTION';
    case 'SOFT_OBJECTION':
      return 'SERIOUS_NOT_READY';
    case 'PRICE_QUESTION_DEFLECTED':
      return 'MONEY_OBJECTION';
    default:
      return 'IN_QUALIFICATION';
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Require ADMIN role
    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { conversations } = body as { conversations: SeedConversation[] };

    if (
      !conversations ||
      !Array.isArray(conversations) ||
      conversations.length === 0
    ) {
      return NextResponse.json(
        { error: 'conversations array is required and must not be empty' },
        { status: 400 }
      );
    }

    let imported = 0;

    for (const convo of conversations) {
      const {
        leadName,
        leadHandle,
        platform,
        outcome,
        leadIntentTag,
        messages
      } = convo;

      if (
        !leadName ||
        !leadHandle ||
        !platform ||
        !outcome ||
        !messages?.length
      ) {
        continue; // Skip invalid entries
      }

      // 1. Create Lead with status derived from outcome
      const lead = await prisma.lead.create({
        data: {
          accountId: auth.accountId,
          name: leadName,
          handle: leadHandle,
          platform,
          status: outcomeToLeadStatus(outcome) as any,
          triggerType: 'DM',
          triggerSource: 'seed-import'
        }
      });

      // 2. Create Conversation with dataSource: SEED
      const conversation = await prisma.conversation.create({
        data: {
          leadId: lead.id,
          outcome: outcome as any,
          leadIntentTag: (leadIntentTag as any) ?? 'NEUTRAL',
          dataSource: 'SEED',
          lastMessageAt: messages[messages.length - 1]?.timestamp
            ? new Date(messages[messages.length - 1].timestamp!)
            : new Date()
        }
      });

      // 3. Create all Messages with provided metadata
      const createdMessages = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const timestamp = msg.timestamp
          ? new Date(msg.timestamp)
          : new Date(Date.now() + i * 60000); // Space 1 min apart if no timestamp

        const created = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: msg.sender as any,
            content: msg.content,
            stage: msg.stage ?? null,
            stageConfidence: msg.stageConfidence ?? null,
            timestamp
          }
        });
        createdMessages.push(created);
      }

      // 4. Back-fill gotResponse and responseTimeSeconds by iterating message pairs
      for (let i = 0; i < createdMessages.length; i++) {
        const current = createdMessages[i];
        const next = createdMessages[i + 1];

        if (current.sender !== 'LEAD') {
          // For AI/HUMAN messages, check if the lead replied
          const gotResponse = next ? next.sender === 'LEAD' : false;
          const responseTimeSeconds =
            gotResponse && next
              ? Math.round(
                  (next.timestamp.getTime() - current.timestamp.getTime()) /
                    1000
                )
              : null;

          await prisma.message.update({
            where: { id: current.id },
            data: { gotResponse, responseTimeSeconds }
          });
        }
      }

      imported++;
    }

    return NextResponse.json({ success: true, imported });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/admin/seed-conversations error:', error);
    return NextResponse.json(
      { error: 'Failed to import seed conversations' },
      { status: 500 }
    );
  }
}
