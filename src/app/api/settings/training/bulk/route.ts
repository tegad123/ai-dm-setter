import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { TrainingCategory } from '@prisma/client';

// ---------------------------------------------------------------------------
// Auto-categorize based on conversation context keywords
// ---------------------------------------------------------------------------

function autoCategorizePair(
  leadMsg: string,
  yourMsg: string,
  sectionTitle: string
): TrainingCategory {
  const lower = (leadMsg + ' ' + yourMsg + ' ' + sectionTitle).toLowerCase();

  // Section title hints
  if (sectionTitle.includes('unqualified')) return 'GENERAL';
  if (sectionTitle.includes('left on read') || sectionTitle.includes('cold'))
    return 'FOLLOW_UP';
  if (sectionTitle.includes('resistant') || sectionTitle.includes('skeptical'))
    return 'OBJECTION_TRUST';
  if (sectionTitle.includes('setter error')) return 'GENERAL';

  // Content-based detection
  if (
    lower.includes('how much') ||
    lower.includes('price') ||
    lower.includes('cost') ||
    lower.includes('afford') ||
    lower.includes('expensive') ||
    lower.includes("don't have money") ||
    lower.includes('in debt')
  )
    return 'OBJECTION_MONEY';
  if (
    lower.includes('scam') ||
    lower.includes("don't trust") ||
    lower.includes('skeptic') ||
    lower.includes('legit') ||
    lower.includes('tried before') ||
    lower.includes("doesn't work")
  )
    return 'OBJECTION_TRUST';
  if (
    lower.includes("don't have time") ||
    lower.includes('too busy') ||
    lower.includes('no time')
  )
    return 'OBJECTION_TIME';
  if (
    lower.includes('tried') &&
    (lower.includes('failed') ||
      lower.includes("didn't work") ||
      lower.includes('lost money'))
  )
    return 'OBJECTION_PRIOR_FAILURE';
  if (
    lower.includes('book') ||
    lower.includes('call') ||
    lower.includes('schedule') ||
    lower.includes('zoom') ||
    lower.includes('time zone')
  )
    return 'CLOSING';
  if (
    lower.includes('follow') ||
    lower.includes("what's good") ||
    lower.includes("what's up") ||
    lower.includes('hey') ||
    lower.includes('yo ')
  )
    return 'GREETING';
  if (
    lower.includes('how long') ||
    lower.includes('full time') ||
    lower.includes('side hustle') ||
    lower.includes('making monthly') ||
    lower.includes('goal') ||
    lower.includes('3-6 months')
  )
    return 'QUALIFICATION';

  return 'GENERAL';
}

// ---------------------------------------------------------------------------
// Parse the [YOU]/[LEAD] markdown format into exchange pairs
// ---------------------------------------------------------------------------

interface ParsedExchange {
  leadMessage: string;
  idealResponse: string;
  category: TrainingCategory;
  conversationTitle: string;
}

function parseConversationMarkdown(
  content: string,
  sectionTitle: string
): ParsedExchange[] {
  const exchanges: ParsedExchange[] = [];

  // Split into lines and process
  const lines = content.split('\n');
  let currentSpeaker: 'LEAD' | 'YOU' | null = null;
  let leadBuffer: string[] = [];
  let youBuffer: string[] = [];
  let conversationTitle = sectionTitle;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect conversation title (### headers)
    if (line.startsWith('### ')) {
      // Flush any pending exchange
      if (leadBuffer.length > 0 && youBuffer.length > 0) {
        exchanges.push({
          leadMessage: leadBuffer.join('\n').trim(),
          idealResponse: youBuffer.join('\n').trim(),
          category: autoCategorizePair(
            leadBuffer.join(' '),
            youBuffer.join(' '),
            sectionTitle
          ),
          conversationTitle
        });
        leadBuffer = [];
        youBuffer = [];
      }
      conversationTitle = line.replace(/^###\s*/, '');
      currentSpeaker = null;
      continue;
    }

    // Skip empty lines and horizontal rules
    if (!line || line === '---') continue;

    // Detect speaker
    if (line.startsWith('[YOU]:')) {
      // If we were collecting lead messages and now YOU is speaking,
      // that's a transition — if we have both, save the pair
      if (currentSpeaker === 'LEAD' && leadBuffer.length > 0) {
        // We had lead messages, now we're about to get response
        // DON'T flush yet — wait until we see the next [LEAD] to complete the pair
      }

      if (currentSpeaker === 'YOU') {
        // Continuation of YOU speaking — append to buffer
        youBuffer.push(line.replace(/^\[YOU\]:\s*/, ''));
      } else {
        // Transition from LEAD to YOU — start collecting response
        if (leadBuffer.length > 0 && youBuffer.length > 0) {
          // We have a complete pair from before — save it
          exchanges.push({
            leadMessage: leadBuffer.join('\n').trim(),
            idealResponse: youBuffer.join('\n').trim(),
            category: autoCategorizePair(
              leadBuffer.join(' '),
              youBuffer.join(' '),
              sectionTitle
            ),
            conversationTitle
          });
          leadBuffer = [];
        }
        youBuffer = [line.replace(/^\[YOU\]:\s*/, '')];
        currentSpeaker = 'YOU';
      }
    } else if (line.startsWith('[LEAD]:')) {
      if (currentSpeaker === 'LEAD') {
        // Continuation of LEAD — append
        leadBuffer.push(line.replace(/^\[LEAD\]:\s*/, ''));
      } else {
        // Transition from YOU to LEAD — save the pair if we have both
        if (youBuffer.length > 0 && leadBuffer.length > 0) {
          exchanges.push({
            leadMessage: leadBuffer.join('\n').trim(),
            idealResponse: youBuffer.join('\n').trim(),
            category: autoCategorizePair(
              leadBuffer.join(' '),
              youBuffer.join(' '),
              sectionTitle
            ),
            conversationTitle
          });
        }
        leadBuffer = [line.replace(/^\[LEAD\]:\s*/, '')];
        youBuffer = [];
        currentSpeaker = 'LEAD';
      }
    }
  }

  // Final flush
  if (leadBuffer.length > 0 && youBuffer.length > 0) {
    exchanges.push({
      leadMessage: leadBuffer.join('\n').trim(),
      idealResponse: youBuffer.join('\n').trim(),
      category: autoCategorizePair(
        leadBuffer.join(' '),
        youBuffer.join(' '),
        sectionTitle
      ),
      conversationTitle
    });
  }

  return exchanges;
}

// ---------------------------------------------------------------------------
// API Route
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { content } = body as { content?: string };

    if (!content || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: content (markdown string)' },
        { status: 400 }
      );
    }

    // Get or create persona
    let persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true }
    });
    if (!persona) {
      return NextResponse.json(
        { error: 'No active persona found. Complete onboarding first.' },
        { status: 400 }
      );
    }

    // Split content by sections (## headers)
    const sections = content.split(/\n(?=## )/);
    const allExchanges: ParsedExchange[] = [];

    for (const section of sections) {
      const headerMatch = section.match(/^##\s+(.+)/);
      const sectionTitle = headerMatch ? headerMatch[1] : '';

      // Skip non-conversation sections (SOP, style guide, etc.)
      if (
        sectionTitle.toLowerCase().includes('table of contents') ||
        sectionTitle.toLowerCase().includes('operating procedures') ||
        sectionTitle.toLowerCase().includes('style guide') ||
        sectionTitle.toLowerCase().includes('sales call transcript')
      ) {
        continue;
      }

      const exchanges = parseConversationMarkdown(section, sectionTitle);
      allExchanges.push(...exchanges);
    }

    if (allExchanges.length === 0) {
      return NextResponse.json(
        {
          error:
            'No conversation exchanges found. Make sure the format uses [YOU]: and [LEAD]: markers.'
        },
        { status: 400 }
      );
    }

    // Batch create all training examples
    const created = await prisma.trainingExample.createMany({
      data: allExchanges.map((ex) => ({
        accountId: auth.accountId,
        personaId: persona!.id,
        category: ex.category,
        leadMessage: ex.leadMessage,
        idealResponse: ex.idealResponse,
        notes: `Imported from: ${ex.conversationTitle}`
      }))
    });

    // Summary by category
    const categorySummary: Record<string, number> = {};
    for (const ex of allExchanges) {
      categorySummary[ex.category] = (categorySummary[ex.category] || 0) + 1;
    }

    return NextResponse.json({
      imported: created.count,
      categories: categorySummary,
      preview: allExchanges.slice(0, 3).map((ex) => ({
        category: ex.category,
        leadMessage:
          ex.leadMessage.length > 100
            ? ex.leadMessage.slice(0, 100) + '...'
            : ex.leadMessage,
        idealResponse:
          ex.idealResponse.length > 100
            ? ex.idealResponse.slice(0, 100) + '...'
            : ex.idealResponse
      }))
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/settings/training/bulk error:', error);
    return NextResponse.json(
      { error: 'Failed to bulk import training data' },
      { status: 500 }
    );
  }
}
