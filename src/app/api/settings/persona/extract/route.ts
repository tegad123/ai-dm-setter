import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// POST /api/settings/persona/extract
// Takes raw document text OR a base64-encoded PDF and uses Claude to extract
// all persona fields including SOP-specific content.
// PDFs are sent directly to Claude as base64 documents (native PDF support).
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert at extracting sales persona configuration from SOPs, playbooks, and sales scripts.

Read the document VERY carefully — it may be a DM setter SOP, sales playbook, brand guide, or onboarding doc. Your job is to extract EVERY piece of actionable information and map it to the correct field in the JSON structure below.

## EXTRACTION RULES — READ THESE CAREFULLY

1. **Extract ACTUAL scripts and messages VERBATIM** — do not summarize. If the document says "send this message: 'Hey bro...'" then put the exact message in the field.
2. **Extract ALL content for each field** — if there are multiple scripts for one scenario (e.g. 3 follow-up attempts for no-shows), combine them all into that field.
3. **Map document sections to fields carefully:**
   - "No-Show" sections → noShowProtocol.firstNoShow and noShowProtocol.secondNoShow
   - "Follow-up" or "Stall" sections → the specific stall type fields (stallTimeScript, stallMoneyScript, stallThinkScript, stallPartnerScript)
   - "Ghost" sequences → followupDay1/Day3/Day7
   - Financial screening steps (capital, credit, card limits) → financialWaterfall array
   - Lower-tier product or course pitches → downsellConfig
   - Founder/origin stories → knowledgeAssets
   - Student/client success stories with names → proofPoints
   - Pre-call reminders (night before, morning of, 1 hour before) → preCallSequence
   - Tone rules, language rules, emoji usage → toneDescription
   - "Never" rules, absolute rules → customRules
   - Urgency questions → urgencyQuestion
   - Booking flow scripts → bookingConfirmationMessage and callPitchMessage
   - Trust/skepticism handling → objectionHandling.trust
   - "I tried before" / "been burned" → objectionHandling.priorFailure
   - Money/pricing objections → objectionHandling.money
   - Time/busy objections → objectionHandling.time
4. **For stall scripts:** Include the IMMEDIATE response AND all follow-up attempts (Attempt 1, 2, 3, and soft exit) as one complete block of text.
5. **For no-show protocol:** Include the full first no-show message AND the second no-show pull-back message. Include any rules about max reschedules.
6. **For pre-call sequence:** Extract each timed message. Use timing values: "night_before", "morning_of", "1_hour_before", "30_min_before".
7. **For financial waterfall:** Extract each level as a separate object. Common levels: Capital, Credit Score, Credit Card Limit.
8. **Never leave a field empty if the document has relevant content.** Search the ENTIRE document for each field.

## OUTPUT JSON STRUCTURE

Return a JSON object with EXACTLY this structure:

{
  "fullName": "The person's full name or brand owner name found in the document",
  "companyName": "Brand or company name",
  "freeValueLink": "Any free resource/video URL mentioned (may be a placeholder like [FREE VALUE VIDEO LINK])",
  "closerName": "Name of the person who handles sales calls if mentioned (e.g. 'Anthony')",
  "objectionHandling": {
    "trust": "FULL trust/skepticism objection handling script — include the complete response with all paragraphs",
    "priorFailure": "FULL 'been burned before' / 'tried this before' objection script",
    "money": "FULL money/pricing objection script",
    "time": "FULL time/busy objection script"
  },
  "promptConfig": {
    "whatYouSell": "Description of the offer/product/service — mentorship, course, coaching, etc.",
    "adminBio": "Bio, credibility, background, origin story summary, results achieved",
    "toneDescription": "How they communicate — include specific words they use ('bro', 'my G'), emoji rules, message length rules, what to never say",
    "toneExamplesGood": "Actual example messages from the document that show the correct tone",
    "toneExamplesBad": "Things they explicitly say to NEVER do or say",
    "openingMessageStyle": "How to open conversations — include both inbound and outbound openers if available",
    "qualificationQuestions": "All qualification/discovery questions from the document as a numbered list",
    "disqualificationCriteria": "When to NOT book a call — all hard disqualifiers mentioned",
    "disqualificationMessage": "What to say when disqualifying — the soft exit message",
    "urgencyQuestion": "The exact urgency question that must fire before the pitch",
    "freeValueMessage": "How to introduce the free resource",
    "freeValueFollowup": "What to say after sending the free resource",
    "callPitchMessage": "How to pitch the call — include beginner and intermediate versions if both exist",
    "bookingConfirmationMessage": "The full booking confirmation script — timezone collection, time proposal, double-down, info collection, confirmation",
    "followupDay1": "Day 1 ghost follow-up message (24hrs after last message)",
    "followupDay3": "Day 2-3 ghost follow-up message",
    "followupDay7": "Final ghost follow-up / ultimatum message",
    "stallTimeScript": "COMPLETE 'text me later / not a good time' handling — immediate response + all 3 follow-up attempts + soft exit",
    "stallMoneyScript": "COMPLETE 'I'll have money next week' handling — immediate response + all 3 follow-up attempts + soft exit",
    "stallThinkScript": "COMPLETE 'let me think about it' handling — immediate response + all 3 follow-up attempts + soft exit",
    "stallPartnerScript": "COMPLETE 'need to talk to wife/partner' handling — immediate response + all 3 follow-up attempts + soft exit",
    "customRules": "ALL absolute rules, never-violate rules, and special instructions — combine into a numbered list"
  },
  "financialWaterfall": [
    {"label": "Level name (e.g. Capital)", "question": "The exact question to ask", "threshold": "What qualifies (e.g. 'Has sufficient capital')", "passAction": "proceed to booking"}
  ],
  "downsellConfig": {
    "productName": "Name of the lower-tier product (e.g. 'Self-Paced Course')",
    "price": "Price (e.g. '$497')",
    "pitchMessage": "The FULL downsell pitch script — all steps combined",
    "link": "Payment link if mentioned (may be placeholder)"
  },
  "knowledgeAssets": [
    {"title": "Asset name", "content": "The FULL narrative content — include the complete story", "deployTrigger": "When to use this"}
  ],
  "proofPoints": [
    {"name": "Person's name", "result": "What they achieved", "deployContext": "When to deploy this proof"}
  ],
  "noShowProtocol": {
    "firstNoShow": "The COMPLETE first no-show message and any rules about offering a reschedule",
    "secondNoShow": "The COMPLETE second no-show pull-back message and any rules about stopping outreach"
  },
  "preCallSequence": [
    {"timing": "night_before|morning_of|1_hour_before", "message": "The exact message to send at this time"}
  ]
}

Return ONLY valid JSON. No markdown code blocks. No explanation before or after. Just the JSON object.`;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const body = await request.json();

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Anthropic API key not configured' },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });

    // Build the message content based on input type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messageContent: any[];

    if (body.pdfBase64) {
      // Send PDF directly to Claude using native PDF support (no parsing library needed)
      messageContent = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: body.pdfBase64
          }
        },
        {
          type: 'text',
          text: EXTRACTION_PROMPT
        }
      ];
    } else if (body.documentText && typeof body.documentText === 'string') {
      const truncated = body.documentText.slice(0, 100000);
      messageContent = [
        {
          type: 'text',
          text: `${EXTRACTION_PROMPT}\n\nDOCUMENT:\n---\n${truncated}\n---`
        }
      ];
    } else {
      return NextResponse.json(
        { error: 'documentText or pdfBase64 is required' },
        { status: 400 }
      );
    }

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [
        {
          role: 'user',
          content: messageContent
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
        console.error(
          'Failed to parse extraction response:',
          responseText.slice(0, 500)
        );
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
