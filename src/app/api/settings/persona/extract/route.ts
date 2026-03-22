import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// POST /api/settings/persona/extract
// Takes raw document text and uses Claude to extract all persona fields
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const { documentText } = await request.json();

    if (!documentText || typeof documentText !== 'string') {
      return NextResponse.json(
        { error: 'documentText is required' },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Anthropic API key not configured' },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `You are an AI assistant that extracts sales persona configuration from documents.

Read the following document carefully and extract ALL relevant information to fill out a DM sales persona profile. The document may be a setter playbook, sales script, brand guide, onboarding doc, or any business document.

Extract and return a JSON object with EXACTLY this structure. Fill in as much as possible from the document. Leave fields as empty strings "" if the information is not found:

{
  "fullName": "The person's full name or brand owner name",
  "companyName": "Brand or company name",
  "freeValueLink": "Any free resource URL mentioned",
  "objectionHandling": {
    "trust": "How to handle trust/skepticism objections - extract actual scripts or approaches",
    "priorFailure": "How to handle 'I've tried this before' objections",
    "money": "How to handle money/pricing objections",
    "time": "How to handle 'I don't have time' objections"
  },
  "promptConfig": {
    "whatYouSell": "Description of the offer/product/service",
    "adminBio": "Bio, credibility, background, results achieved",
    "toneDescription": "How they communicate - casual, professional, direct, etc.",
    "toneExamplesGood": "Example messages that match their voice (paste actual examples if found)",
    "toneExamplesBad": "Things they would NEVER say or styles to avoid",
    "openingMessageStyle": "How they typically open conversations with new leads",
    "qualificationQuestions": "Questions used to qualify leads (numbered list)",
    "disqualificationCriteria": "When NOT to book a call / red flags",
    "disqualificationMessage": "What to say when disqualifying someone",
    "freeValueMessage": "How to introduce free resources",
    "freeValueFollowup": "What to say after sending a free resource",
    "callPitchMessage": "How to pitch booking a call",
    "bookingConfirmationMessage": "What to say when a call is booked",
    "followupDay1": "24-hour follow-up message if lead goes quiet",
    "followupDay3": "3-day follow-up message",
    "followupDay7": "7-day final follow-up message",
    "customRules": "Any special rules, do's and don'ts, or instructions"
  }
}

IMPORTANT:
- Extract ACTUAL scripts, messages, and language from the document, not summaries
- If the document contains example DMs or scripts, use those verbatim
- Capture their unique voice, slang, emoji usage, and communication style
- Be thorough — fill every field you can find relevant information for

DOCUMENT:
---
${documentText}
---

Return ONLY the JSON object, no markdown formatting, no code blocks, no explanation.`
        }
      ]
    });

    // Extract the text response
    const responseText =
      message.content[0].type === 'text' ? message.content[0].text : '';

    // Parse the JSON response
    let extracted;
    try {
      // Try to parse directly
      extracted = JSON.parse(responseText);
    } catch {
      // Try to extract JSON from potential markdown code block
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      } else {
        return NextResponse.json(
          { error: 'Failed to parse AI response' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ extracted });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Persona extraction error:', error);
    return NextResponse.json(
      { error: 'Failed to extract persona from document' },
      { status: 500 }
    );
  }
}
