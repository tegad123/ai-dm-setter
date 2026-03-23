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

Read the following document carefully and extract ALL relevant information to fill out a DM sales persona profile. The document may be a setter playbook, sales script, brand guide, onboarding doc, SOP, or any business document.

Extract and return a JSON object with EXACTLY this structure. Fill in as much as possible from the document. Leave fields as empty strings "" or empty arrays [] if the information is not found:

{
  "fullName": "The person's full name or brand owner name",
  "companyName": "Brand or company name",
  "freeValueLink": "Any free resource URL mentioned",
  "closerName": "Name of the person who handles sales calls (if different from the owner)",
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
    "urgencyQuestion": "The urgency question asked before pitching (e.g. 'Why is now the time to make this happen?')",
    "freeValueMessage": "How to introduce free resources",
    "freeValueFollowup": "What to say after sending a free resource",
    "callPitchMessage": "How to pitch booking a call",
    "bookingConfirmationMessage": "What to say when a call is booked",
    "followupDay1": "24-hour follow-up message if lead goes quiet",
    "followupDay3": "3-day follow-up message",
    "followupDay7": "7-day final follow-up message",
    "stallTimeScript": "How to handle 'text me later / not a good time' stalls",
    "stallMoneyScript": "How to handle 'I'll have money next week' stalls",
    "stallThinkScript": "How to handle 'let me think about it' stalls",
    "stallPartnerScript": "How to handle 'I need to talk to my wife/partner' stalls",
    "customRules": "Any special rules, do's and don'ts, or instructions"
  },
  "financialWaterfall": [
    {"label": "Level name", "question": "Question to ask at this level", "threshold": "Qualifying threshold", "passAction": "What happens if they qualify"}
  ],
  "downsellConfig": {
    "productName": "Name of the lower-tier product",
    "price": "Price of the downsell product",
    "pitchMessage": "How to pitch the downsell product",
    "link": "Payment or checkout link for the downsell"
  },
  "knowledgeAssets": [
    {"title": "Asset name (e.g. Founder Origin Story)", "content": "The full narrative content", "deployTrigger": "When to use this (e.g. trust objection, rapport building)"}
  ],
  "proofPoints": [
    {"name": "Student/client name", "result": "What they achieved", "deployContext": "When to deploy this proof point"}
  ],
  "noShowProtocol": {
    "firstNoShow": "Message for first no-show — extend one reschedule",
    "secondNoShow": "Message for second no-show — pull back and challenge commitment"
  },
  "preCallSequence": [
    {"timing": "night_before|morning_of|1_hour_before|30_min_before", "message": "Message to send at this timing"}
  ]
}

IMPORTANT:
- Extract ACTUAL scripts, messages, and language from the document, not summaries
- If the document contains example DMs or scripts, use those verbatim
- Capture their unique voice, slang, emoji usage, and communication style
- Be thorough — fill every field you can find relevant information for
- For financialWaterfall, extract multi-level financial screening steps (e.g. capital → credit score → card limit)
- For knowledgeAssets, extract founder stories, origin stories, or narrative content used for trust building
- For proofPoints, extract specific student/client success stories with names and results
- For preCallSequence, extract any timed reminder messages sent before scheduled calls
- For stall scripts, extract specific responses for each type of stall (time delay, money delay, thinking, partner)

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
