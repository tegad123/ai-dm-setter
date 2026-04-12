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

The target system is a 7-stage DM setter AI that runs conversations through:
1. OPENING  2. SITUATION_DISCOVERY (with BEGINNER / EXPERIENCED Path A/B routing)  3. GOAL_EMOTIONAL_WHY
4. URGENCY  5. SOFT_PITCH_COMMITMENT  6. FINANCIAL_SCREENING (4-level waterfall)  7. BOOKING

## EXTRACTION RULES — READ THESE CAREFULLY

1. **Extract ACTUAL scripts and messages VERBATIM** — do not summarize. If the document says "send this message: 'Hey bro...'" then put the exact message in the field.
2. **Extract ALL content for each field** — if there are multiple scripts for one scenario (e.g. 3 follow-up attempts for no-shows), combine them all into that field.
3. **First-person rewrite** — the document may refer to the persona owner by name (e.g. "Daniel should say..."). In extracted scripts, convert these to first-person ("I", "me", "my") because the AI IS the persona owner talking directly to the lead.
4. **Setter vs closer handoff** — If the document says the SETTER (the DM persona) is different from the CLOSER (who takes the actual sales call), capture BOTH names and the handoff instruction. Example: "Daniel sets in DMs, Anthony closes on the call" → closerName: "Anthony", callHandoff populated.
5. **Path A vs Path B** — Many SOPs classify leads as BEGINNER vs EXPERIENCED and route to different scripts. Extract the keywords used to classify + the separate script paths.
6. **Emotional pause rule** — If the document has instructions about how to respond to emotional disclosures (absent parent, financial stress, family struggles), extract as emotionalDisclosurePatterns.
7. **Income empathy anchor** — If the document says to attach a specific empathy line when asking about income (e.g. "asking since I used to work similar jobs"), extract as incomeFramingRule.
8. **For stall scripts:** Include the IMMEDIATE response AND all follow-up attempts (Attempt 1, 2, 3, and soft exit) as one complete block of text.
9. **For no-show protocol:** Include the full first no-show message AND the second no-show pull-back message. Include any rules about max reschedules.
10. **For pre-call sequence:** Extract each timed message. Use timing values: "night_before", "morning_of", "1_hour_before", "30_min_before".
11. **For financial waterfall:** Extract each level as a separate object. Common levels: Capital, Credit Score, Credit Card Limit, Low-Ticket Pitch.
12. **Never leave a field empty if the document has relevant content.** Search the ENTIRE document for each field.

## SECTION-TO-FIELD MAPPING

- "No-Show" sections → noShowProtocol.firstNoShow, noShowProtocol.secondNoShow AND promptConfig.noShowScripts
- "Follow-up" or "Stall" sections → promptConfig.stall{Time,Money,Think,Partner}Script (legacy) AND promptConfig.stallScripts.{TIME_DELAY,MONEY_DELAY,THINKING,PARTNER,GHOST} (new structured)
- "Ghost" sequences → promptConfig.followupDay{1,3,7} (legacy) AND promptConfig.stallScripts.GHOST (new)
- Financial screening steps (capital, credit, card limits, low-ticket) → financialWaterfall array AND promptConfig.financialScreeningScripts
- Founder/origin stories → knowledgeAssets (legacy) AND promptConfig.originStory (new, full narrative)
- Student/client success stories with names → proofPoints
- Pre-call reminders (night before, morning of, 1 hour before) → preCallSequence AND promptConfig.preCallMessages
- Tone rules, language rules, emoji usage → promptConfig.toneDescription
- "Never" rules, absolute rules → promptConfig.customRules
- Urgency questions → promptConfig.urgencyQuestion (legacy) AND promptConfig.urgencyScripts (new, full narrative)
- Booking flow scripts → promptConfig.bookingConfirmationMessage (legacy) AND promptConfig.bookingScripts (new, structured by step)
- Soft pitch / call pitch scripts → promptConfig.callPitchMessage (legacy) AND promptConfig.softPitchScripts (new, beginner/experienced + commitment)
- Objections:
  * Trust / skepticism / scam fears → objectionHandling.trust (legacy) AND promptConfig.objectionProtocols.TRUST (new)
  * "I tried before" / "been burned" / fear of another failure → objectionHandling.priorFailure (legacy) AND promptConfig.objectionProtocols.FEAR_OF_LOSS (new)
  * "I don't have the energy" / "I'm burned out" → promptConfig.objectionProtocols.LOW_ENERGY (new)
  * "I already have a mentor" / "I'm already in a program" → promptConfig.objectionProtocols.HAS_MENTOR (new)
  * "I'm not ready" / "maybe later" / "timing isn't right" → promptConfig.objectionProtocols.NOT_READY (new)
  * Money/pricing → objectionHandling.money (legacy — money typically handled via financial waterfall in new system)
  * Time/busy → objectionHandling.time (legacy — time typically handled via urgency stage in new system)

## OUTPUT JSON STRUCTURE

Return a JSON object with EXACTLY this structure. Include BOTH legacy and new fields so old UI and new runtime both work.

{
  "fullName": "The person's full name or brand owner name found in the document",
  "companyName": "Brand or company name",
  "freeValueLink": "Any free resource/video URL mentioned (may be a placeholder like [FREE VALUE VIDEO LINK])",
  "closerName": "Name of the person who handles sales calls if different from the DM setter — e.g. 'Anthony'. Empty string if the setter also takes the call.",
  "objectionHandling": {
    "trust": "FULL trust/skepticism objection handling script — include the complete response with all paragraphs",
    "priorFailure": "FULL 'been burned before' / 'tried this before' objection script",
    "money": "FULL money/pricing objection script",
    "time": "FULL time/busy objection script"
  },
  "promptConfig": {
    // ── LEGACY FIELDS (kept for the settings UI) ──
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
    "customRules": "ALL absolute rules, never-violate rules, and special instructions — combine into a numbered list",

    // ── NEW SOP FIELDS (read by the 7-stage runtime) ──

    "callHandoff": {
      "closerName": "Name of the person taking the actual sales call (e.g. 'Anthony'). Empty string or omit if the DM setter is also the closer.",
      "closerRelation": "Relationship phrasing — 'my partner', 'my co-founder', 'the closer on our team', 'my business partner', etc.",
      "closerRole": "What they do — 'runs all our strategy calls', 'handles onboarding', 'closes deals'. Used to introduce them naturally."
    },

    "originStory": "The FULL origin story / founder narrative — complete paragraphs, first-person. Used for trust-building and objection handling.",

    "openingScripts": {
      "inbound": "Exact opening message when the lead messaged first (e.g. replied to a story)",
      "outbound": "Exact opening message when the AI reaches out first",
      "openingQuestion": "The single opening discovery question that kicks off Stage 1"
    },

    "beginnerKeywords": ["array", "of", "phrases", "that indicate", "a beginner lead", "e.g. 'never done this'", "'just learning'", "'curious about'"],
    "experiencedKeywords": ["array", "of", "phrases", "that indicate", "an experienced lead", "e.g. 'been doing this for'", "'years of experience'", "'I already do'"],

    "pathAScripts": "FULL script content for EXPERIENCED leads (Path A) — discovery questions, framing, positioning. Can be a paragraph block or structured object.",
    "pathBScripts": "FULL script content for BEGINNER leads (Path B) — discovery questions, framing, positioning. Can be a paragraph block or structured object.",

    "goalEmotionalWhyScripts": {
      "incomeGoal": "Exact script for asking about income goals (Stage 3 layer 1)",
      "bridgeQuestion": "The bridge question that pivots from money → family/life (Stage 3 layer 2)",
      "obstacleQuestion": "The obstacle question — what's held them back (Stage 3 layer 3)"
    },

    "emotionalDisclosurePatterns": "Instructions and example responses for when the lead discloses deep personal pain (absent parent, financial stress, family struggles). The AI must acknowledge the SPECIFIC content of what they shared. Include example acknowledgment patterns for different scenarios.",

    "incomeFramingRule": "The empathy anchor line that must be attached to the income question — e.g. 'Asking since I used to work jobs similar to that'. This goes after the income question every time.",

    "urgencyScripts": "FULL Stage 4 urgency script — the question + any setup framing. This is MANDATORY and cannot be skipped before the soft pitch.",

    "softPitchScripts": {
      "beginner": "Full soft pitch script for beginner leads (Path B)",
      "experienced": "Full soft pitch script for experienced leads (Path A)",
      "commitmentConfirmation": "The commitment confirmation script that fires AFTER the lead says yes to the soft pitch — locks in their commitment before moving to financial screening."
    },

    "financialScreeningScripts": {
      "level1_capital": "Exact script for asking about available capital (Level 1)",
      "level2_creditScore": "Exact script for asking about credit score (Level 2 — fires only if capital insufficient)",
      "level3_creditCard": "Exact script for asking about credit card limit (Level 3 — fires only if credit insufficient)",
      "level4_lowTicket": "Intro to the low-ticket pitch (Level 4 — fires only if all 3 financial checks fail)"
    },

    "lowTicketPitchScripts": "The FULL multi-message low-ticket pitch sequence — this is a complete DM close sequence for leads who can't afford the main offer. Include every step of the sequence.",

    "bookingScripts": {
      "transition": "How to transition from commitment → booking",
      "timezoneAsk": "How to ask for timezone before proposing any time",
      "slotPropose": "How to propose specific times (will be substituted with real calendar slots at runtime)",
      "doubleDown": "How to handle hesitation when proposing times",
      "infoCollect": "How to ask for email and any other booking info",
      "confirm": "How to confirm the booked slot"
    },

    "objectionProtocols": {
      "TRUST": "FULL protocol for trust/scam/skepticism objections — include the complete response + any proof points to reference",
      "FEAR_OF_LOSS": "FULL protocol for 'I tried before and lost money' / 'been burned' objections",
      "LOW_ENERGY": "FULL protocol for 'I'm too burned out' / 'I don't have the energy' objections",
      "HAS_MENTOR": "FULL protocol for 'I already have a mentor' / 'already in a program' objections",
      "NOT_READY": "FULL protocol for 'I'm not ready' / 'maybe later' / 'timing isn't right' objections"
    },

    "stallScripts": {
      "TIME_DELAY": {
        "immediate": "First response when lead says 'text me later' / 'not a good time'",
        "followup1": "Follow-up attempt 1 (fires slightly BEFORE the implied time)",
        "followup2": "Follow-up attempt 2",
        "followup3": "Follow-up attempt 3 (final ultimatum, not a check-in)",
        "softExit": "Final soft exit message after 3 failed attempts"
      },
      "MONEY_DELAY": {
        "immediate": "First response when lead says 'I'll have money next week'",
        "followup1": "Follow-up attempt 1 (fires 1-2 days BEFORE their stated date)",
        "followup2": "Follow-up attempt 2",
        "followup3": "Follow-up attempt 3",
        "softExit": "Final soft exit message"
      },
      "THINKING": {
        "immediate": "First response when lead says 'let me think about it' — probe what specifically they're weighing",
        "followup1": "Follow-up attempt 1",
        "followup2": "Follow-up attempt 2",
        "followup3": "Follow-up attempt 3",
        "softExit": "Final soft exit message"
      },
      "PARTNER": {
        "immediate": "First response when lead says 'need to talk to wife/husband/partner' — arm them with proof",
        "followup1": "Follow-up attempt 1",
        "followup2": "Follow-up attempt 2",
        "followup3": "Follow-up attempt 3",
        "softExit": "Final soft exit message"
      },
      "GHOST": {
        "followup1": "24hr ghost follow-up",
        "followup2": "48hr ghost follow-up",
        "followup3": "72hr ghost follow-up (final ultimatum)",
        "softExit": "Final soft exit message after ghost sequence"
      }
    },

    "noShowScripts": {
      "firstNoShow": "Complete first no-show message with reschedule offer",
      "secondNoShow": "Complete second no-show pull-back message",
      "rules": "Any rules about max reschedules, stopping outreach, etc."
    },

    "preCallMessages": [
      {"timing": "night_before", "message": "9pm night-before nurture message"},
      {"timing": "morning_of", "message": "9:30-10am morning-of message"},
      {"timing": "1_hour_before", "message": "1-hour reminder message"}
    ],

    "assetLinks": {
      "freeValue": "URL to free value resource",
      "bookingLink": "Fallback booking link if no calendar integration",
      "proofScreenshots": "URL to proof/testimonial screenshots",
      "other": "Any other asset URLs mentioned in the document"
    }
  },
  "financialWaterfall": [
    {"label": "Level name (e.g. Capital)", "question": "The exact question to ask", "threshold": "What qualifies (e.g. 'Has sufficient capital')", "passAction": "proceed to booking"}
  ],
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

If a field has no content in the document, use an empty string "" for string fields, [] for array fields, or {} for object fields — but STILL include the key. Never omit keys.

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

    // Use streaming to avoid Anthropic SDK timeout on large max_tokens requests
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [
        {
          role: 'user',
          content: messageContent
        }
      ]
    });

    const message = await stream.finalMessage();

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
