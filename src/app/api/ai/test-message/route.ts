import { requireAuth, AuthError } from '@/lib/auth-guard';
import { buildDynamicSystemPrompt } from '@/lib/ai-prompts';
import { NextRequest, NextResponse } from 'next/server';
import { getCredentials } from '@/lib/credential-store';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// POST — Send a test message to preview how the AI responds
// Used in onboarding's "Review & Activate" step so admins can see the AI
// in action before going live.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { leadMessage, imageUrl, leadName, platform, triggerType } = body as {
      leadMessage?: string;
      imageUrl?: string;
      leadName?: string;
      platform?: string;
      triggerType?: string;
    };

    if (!leadMessage && !imageUrl) {
      return NextResponse.json(
        { error: 'leadMessage or imageUrl is required' },
        { status: 400 }
      );
    }

    // Test-message endpoint runs against the account's active persona.
    // No Conversation row exists for these one-off probes, so this is
    // the legitimate "active persona" lookup case (parallel to the
    // onboarding test endpoint), not the F3.2 anti-pattern.
    const testMessagePersona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true },
      select: { id: true },
      orderBy: { updatedAt: 'desc' }
    });
    if (!testMessagePersona) {
      return NextResponse.json(
        { error: 'No active AIPersona configured for this account' },
        { status: 400 }
      );
    }

    // Build the system prompt with test lead context
    const systemPrompt = await buildDynamicSystemPrompt(
      auth.accountId,
      testMessagePersona.id,
      {
        leadName: leadName || 'Test Lead',
        handle: 'testlead',
        platform: platform || 'INSTAGRAM',
        status: 'NEW_LEAD', // LeadContext interface still uses 'status' field name for the AI prompt
        triggerType: triggerType || 'DM',
        triggerSource: null,
        qualityScore: 50
      }
    );

    // Resolve the user's AI provider credentials
    const openaiCreds = await getCredentials(auth.accountId, 'OPENAI');
    const anthropicCreds = await getCredentials(auth.accountId, 'ANTHROPIC');

    let provider: 'openai' | 'anthropic' = 'openai';
    let apiKey: string | undefined;
    let model: string | undefined;

    if (openaiCreds?.apiKey) {
      provider = 'openai';
      apiKey = openaiCreds.apiKey;
      model = openaiCreds.model || 'gpt-4o';
    } else if (anthropicCreds?.apiKey) {
      provider = 'anthropic';
      apiKey = anthropicCreds.apiKey;
      model = anthropicCreds.model || 'claude-sonnet-4-20250514';
    } else {
      // Fallback to platform env vars
      const envProvider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
      provider = envProvider === 'anthropic' ? 'anthropic' : 'openai';
      apiKey =
        provider === 'anthropic'
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;
      model =
        process.env.AI_MODEL ||
        (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');
    }

    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'No AI provider configured. Please add your API key in Settings → Integrations first.'
        },
        { status: 400 }
      );
    }

    // Make the AI call. When imageUrl is present, use the same low-detail
    // vision shape as the production DM pipeline.
    const leadText =
      leadMessage || 'The lead sent this image without any text message.';
    const openAIMessages = imageUrl
      ? [
          {
            role: 'user' as const,
            content: [
              {
                type: 'image_url' as const,
                image_url: { url: imageUrl, detail: 'low' as const }
              },
              { type: 'text' as const, text: leadText }
            ]
          }
        ]
      : [{ role: 'user' as const, content: leadText }];
    const anthropicMessages = imageUrl
      ? [
          {
            role: 'user' as const,
            content: [
              {
                type: 'image' as const,
                source: { type: 'url' as const, url: imageUrl }
              },
              { type: 'text' as const, text: leadText }
            ]
          }
        ]
      : [{ role: 'user' as const, content: leadText }];

    let rawResponse: string;

    if (provider === 'openai') {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model: model || 'gpt-4o',
        temperature: 0.85,
        max_completion_tokens: 500,
        messages: [
          { role: 'system' as const, content: systemPrompt },
          ...openAIMessages
        ] as any
      });
      rawResponse = response.choices[0]?.message?.content?.trim() || '';
    } else {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: model || 'claude-sonnet-4-20250514',
        system: systemPrompt,
        temperature: 0.85,
        max_tokens: 500,
        messages: anthropicMessages as any
      });
      const textBlock = response.content.find((block) => block.type === 'text');
      rawResponse = textBlock?.text?.trim() || '';
    }

    // Parse structured response
    let parsed: {
      format: string;
      message: string;
      stage: string;
      suggested_tag: string;
    };
    try {
      let jsonStr = rawResponse;
      const jsonMatch = rawResponse.match(
        /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/
      );
      if (jsonMatch) jsonStr = jsonMatch[1].trim();
      const obj = JSON.parse(jsonStr);
      parsed = {
        format: obj.format || 'text',
        message: obj.message || rawResponse,
        stage: obj.stage || '',
        suggested_tag: obj.suggested_tag || ''
      };
    } catch {
      parsed = {
        format: 'text',
        message: rawResponse,
        stage: '',
        suggested_tag: ''
      };
    }

    return NextResponse.json({
      response: parsed.message,
      format: parsed.format,
      stage: parsed.stage,
      suggestedTag: parsed.suggested_tag,
      raw: rawResponse
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/ai/test-message error:', error);
    // Surface the actual API error message to the user
    const errMsg =
      error instanceof Error
        ? error.message
        : 'Failed to generate test response';
    // Extract Anthropic/OpenAI specific error messages
    const match = errMsg.match(/"message":"([^"]+)"/);
    return NextResponse.json(
      { error: match ? match[1] : errMsg },
      { status: 500 }
    );
  }
}
