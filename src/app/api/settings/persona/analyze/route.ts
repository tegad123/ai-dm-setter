import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// POST /api/settings/persona/analyze
// Takes raw document text OR a base64-encoded PDF and uses Claude to produce:
//   1. rawScript  — plain-text content of the document
//   2. styleAnalysis — markdown analysis of the sales style
// ---------------------------------------------------------------------------

const ANALYSIS_PROMPT = `You are an expert sales script analyst. You will receive a sales script, setter SOP, playbook, or brand guide.

Your job is to produce TWO outputs as a JSON object with keys "rawScript" and "styleAnalysis".

## OUTPUT 1: rawScript
Extract the complete plain-text content of the document. Preserve the original structure, headings, and formatting as closely as possible. Convert any non-text content (tables, bullet points) to readable text. First-person rewrite: if the document refers to the persona owner by name in third person (e.g. "Daniel should say..."), convert those instructions to first-person ("I say...") since the AI IS the persona owner.

## OUTPUT 2: styleAnalysis
Write a detailed markdown analysis of the sales style and methodology found in the document. This analysis will be read by an AI that uses it to match the seller's communication style in DM conversations.

Structure your analysis with these exact sections:

### Communication Style
Tone, formality level, typical sentence structure, average message length, emoji usage patterns, slang/catchphrases, punctuation habits. Include SPECIFIC examples from the script.

### Opening Approach
How the script opens conversations for inbound vs outbound leads. The pattern of the first few exchanges. What the opening question is.

### Discovery & Qualification
How leads are classified (beginner vs experienced keywords if present). What questions are asked during discovery. How topics transition. What disqualifies a lead.

### Emotional Engagement
How the script handles emotional disclosures and vulnerability. Empathy anchors. How income questions are framed. Any specific compassion patterns.

### Pitch Style
How the offer is presented (soft pitch approach). Commitment confirmation patterns. How beginner vs experienced leads are pitched differently. What the offer is positioned as.

### Financial Qualification
How the capital/credit/card waterfall is handled. The tone during financial questions. Any low-ticket alternatives. Income framing rules.

### Objection Handling
For each objection type found (trust/skepticism, fear of loss, has mentor, not ready, low energy, money, time), describe the handling PATTERN — not just the script, but the underlying strategy (acknowledge, probe, reframe, etc.).

### Stall & Follow-up
How different stall types are handled (time delay, money delay, thinking, partner, ghost). Follow-up cadence. Escalation approach. What the final ultimatum sounds like.

### Booking Flow
How timezone is collected. How times are proposed. How hesitation on times is handled. Confirmation style. Any closer handoff (who takes the call).

### No-Show & Pre-Call
No-show messaging style and cadence. Pre-call nurture approach and timing.

### Key Phrases & Vocabulary
List specific phrases the seller uses frequently. Words and expressions to adopt. Words or phrases explicitly banned or to avoid.

### Proof Points & Stories
Any client success stories, origin story elements, or social proof embedded in the script. Include names, results, and when to deploy them.

## RULES
- Be SPECIFIC. Quote actual phrases from the document.
- If a section has no corresponding content in the document, write "Not specified in the uploaded script." for that section.
- The styleAnalysis should be comprehensive but practical — it's a reference guide for an AI, not a summary for a human.
- Do NOT add information not present in the document. Only analyze what's actually there.

## OUTPUT FORMAT
Return ONLY valid JSON with this structure (no markdown code blocks, no text before or after):
{
  "rawScript": "the complete document text...",
  "styleAnalysis": "the markdown analysis..."
}`;

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Anthropic API key not configured' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const client = new Anthropic({ apiKey });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messageContent: any[];

    if (body.pdfBase64) {
      messageContent = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: body.pdfBase64
          }
        },
        { type: 'text', text: ANALYSIS_PROMPT }
      ];
    } else if (body.documentText && typeof body.documentText === 'string') {
      const truncated = body.documentText.slice(0, 100000);
      messageContent = [
        {
          type: 'text',
          text: `${ANALYSIS_PROMPT}\n\nDOCUMENT:\n---\n${truncated}\n---`
        }
      ];
    } else {
      return NextResponse.json(
        { error: 'documentText or pdfBase64 is required' },
        { status: 400 }
      );
    }

    // Use streaming to avoid Anthropic SDK timeout on large max_tokens requests
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [{ role: 'user', content: messageContent }]
    });

    const message = await stream.finalMessage();

    const responseText =
      message.content[0].type === 'text' ? message.content[0].text : '';

    let parsed: { rawScript: string; styleAnalysis: string };
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        console.error(
          '[persona/analyze] Failed to parse response:',
          responseText.slice(0, 500)
        );
        return NextResponse.json(
          { error: 'Failed to parse AI response' },
          { status: 500 }
        );
      }
    }

    if (!parsed.rawScript || !parsed.styleAnalysis) {
      return NextResponse.json(
        { error: 'AI response missing rawScript or styleAnalysis' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      rawScript: parsed.rawScript,
      styleAnalysis: parsed.styleAnalysis
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('[persona/analyze] Error:', error);
    return NextResponse.json(
      { error: 'Failed to analyze script' },
      { status: 500 }
    );
  }
}
