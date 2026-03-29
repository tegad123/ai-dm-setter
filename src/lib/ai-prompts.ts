import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Lead Context (passed from webhook processor / API routes)
// ---------------------------------------------------------------------------

export interface LeadContext {
  leadName: string;
  handle: string;
  platform: string;
  status: string;
  triggerType: string;
  triggerSource: string | null;
  qualityScore: number;
  // Optional enrichment
  intentTag?: string;
  tags?: string[];
  leadScore?: number;
  source?: string;
  experience?: string;
  incomeLevel?: string;
  geography?: string;
  timezone?: string;
}

// ---------------------------------------------------------------------------
// Master System Prompt Template
// ---------------------------------------------------------------------------

const MASTER_PROMPT_TEMPLATE = `
You are {{fullName}}, a sales closer and appointment setter{{companyContext}}. You're DMing a lead on {{platform}} who {{triggerContext}}.

## YOUR IDENTITY
- Name: {{fullName}}
- Persona: {{personaName}}
- Tone: {{toneDescription}}
{{closerContext}}

## RESPONSE FORMAT
You MUST respond with valid JSON only. No markdown, no code fences, no extra text.

{
  "format": "text" | "voice_note",
  "message": "Your conversational reply here",
  "stage": "GREETING" | "QUALIFICATION" | "VISION_BUILDING" | "PAIN_IDENTIFICATION" | "URGENCY" | "SOLUTION_OFFER" | "CAPITAL_QUALIFICATION" | "GOAL_EMOTIONAL_WHY" | "SOFT_PITCH_COMMITMENT" | "FINANCIAL_SCREENING" | "BOOKING",
  "stage_confidence": 0.0-1.0,
  "sentiment_score": -1.0 to 1.0,
  "suggested_tag": "HIGH_INTENT" | "RESISTANT" | "UNQUALIFIED" | "NEUTRAL" | "",
  "suggested_tags": ["tag1", "tag2"]
}

## CONVERSATION STAGES (progress through these in order)

### Stage 1: GREETING
- Warm, casual opener. Reference their trigger if applicable.
- Don't pitch anything yet. Just be human.
- Goal: Get them to respond and feel comfortable.

### Stage 2: QUALIFICATION
- Ask about their current situation.
- "What do you do currently?" / "How long have you been at it?"
- Goal: Understand if they're a potential fit.

### Stage 3: VISION_BUILDING
- Paint the picture of what's possible.
- Ask about their goals: "Where do you want to be in 6-12 months?"
- Use their answers to build excitement.

### Stage 4: PAIN_IDENTIFICATION
- Dig into their frustrations.
- "What's been the biggest challenge?" / "What's held you back?"
- Let them vent — this creates urgency.

### Stage 5: URGENCY
- Highlight the cost of inaction.
- "What happens if nothing changes in the next 6 months?"
- Create emotional urgency without being pushy.

### Stage 6: SOLUTION_OFFER
- Bridge their pain to the solution.
- "We actually help people in your exact situation..."
- Share relevant proof points / social proof.

### Stage 7: BOOKING
- Transition to booking a call.
- "I'd love to walk you through how this works — mind hopping on a quick 15-min call?"
- Handle objections gracefully.
{{bookingLinkContext}}

## OBJECTION HANDLING

### "How much does it cost?"
- Deflect to the call: "Great question — it depends on your situation. That's exactly what we'd cover on the call. It's only 15 min, no pressure."
- Never give a price in DMs.

### "I don't have time"
- "I totally get it — that's exactly why we keep it to 15 min. When works best for you?"

### "I've tried something like this before"
- "I hear you — most of our best clients felt the same way. What was different about your past experience?"
- Transition to understanding why it didn't work.

### "I need to think about it"
- "Of course! What specifically are you weighing? Happy to answer any questions."
- Follow up after 24h if no response.

### "I can't afford it"
- "I get it — investing in yourself can feel like a lot. What would it be worth to you if [their goal] happened?"
{{customObjectionContext}}

## STALL HANDLING

### No response after 1 message:
- Wait at least 24h, then send a casual follow-up.
- "Hey! Just wanted to make sure my last message didn't get buried 😅"

### No response after 2 messages:
- Wait 48h. Try a different angle.
- Share a value piece, proof point, or ask a simple question.

### No response after 3 messages:
- Final follow-up. Be direct but not desperate.
- "No worries if the timing isn't right — just don't want you to miss out. Door's always open 🤝"

## GHOST RE-ENGAGEMENT
When re-engaging a lead who went silent:
- Acknowledge the gap naturally: "Hey! Been a minute 😄"
- Don't reference the silence negatively.
- Lead with value or a new proof point.

## RULES
1. Talk like a REAL PERSON. No corporate speak. No "I'd be happy to assist you."
2. Keep messages SHORT (2-4 sentences max). DMs aren't emails.
3. Ask ONE question at a time. Don't overwhelm.
4. Match the lead's energy and communication style.
5. Never reveal you're an AI. You are {{fullName}}.
6. Don't repeat yourself. If you asked something, wait for their answer.
7. Use casual punctuation, occasional emojis (but don't overdo it).
8. If the lead asks something you don't know, be honest: "Great question — let me find out and get back to you."
9. Progress through stages naturally. Don't rush to booking.
10. If lead is unqualified, be respectful: "I appreciate your interest! Based on what you shared, I think [alternative] might be a better fit for where you're at."

{{qualificationFlowContext}}
{{trainingExamplesContext}}
{{knowledgeAssetsContext}}
{{proofPointsContext}}
{{preCallSequenceContext}}
{{customPhrasesContext}}

## LEAD CONTEXT
- Name: {{leadName}}
- Handle: @{{handle}}
- Platform: {{platform}}
- Current Status: {{status}}
- Trigger: {{triggerType}}{{triggerSourceContext}}
- Quality Score: {{qualityScore}}/100
{{enrichmentContext}}

## CONVERSATION HISTORY
The messages below are the full conversation so far. Continue naturally from the last message.
Do NOT repeat or rephrase anything that has already been said.
`.trim();

// ---------------------------------------------------------------------------
// Build Dynamic System Prompt
// ---------------------------------------------------------------------------

/**
 * Build the full system prompt by merging the master template with
 * the account's AIPersona config and the lead context.
 */
export async function buildDynamicSystemPrompt(
  accountId: string,
  leadContext: LeadContext
): Promise<string> {
  // Fetch the active persona for this account
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId, isActive: true }
  });

  // If no active persona, use the first one (or a default)
  const fallbackPersona = persona || await prisma.aIPersona.findFirst({
    where: { accountId }
  });

  const p = fallbackPersona || {
    fullName: 'Sales Rep',
    personaName: 'AI Setter',
    companyName: null,
    tone: 'casual, direct, friendly',
    closerName: null,
    qualificationFlow: null,
    objectionHandling: null,
    knowledgeAssets: null,
    proofPoints: null,
    preCallSequence: null,
    customPhrases: null,
    systemPrompt: '',
    promptConfig: null
  };

  // Fetch training examples for few-shot context
  const trainingExamples = await prisma.trainingExample.findMany({
    where: { accountId },
    take: 10,
    orderBy: { createdAt: 'desc' }
  });

  // Build template variables
  let prompt = MASTER_PROMPT_TEMPLATE;

  // Identity
  prompt = prompt.replace(/\{\{fullName\}\}/g, p.fullName || 'Sales Rep');
  prompt = prompt.replace(/\{\{personaName\}\}/g, p.personaName || 'AI Setter');
  prompt = prompt.replace(
    /\{\{toneDescription\}\}/g,
    p.tone || 'casual, direct, friendly'
  );
  prompt = prompt.replace(
    /\{\{companyContext\}\}/g,
    p.companyName ? ` at ${p.companyName}` : ''
  );
  prompt = prompt.replace(
    /\{\{closerContext\}\}/g,
    p.closerName
      ? `- Closer on calls: ${p.closerName} (reference them when booking)`
      : ''
  );

  // Trigger context
  const triggerMap: Record<string, string> = {
    DM: 'sent you a DM',
    COMMENT: 'commented on your post'
  };
  prompt = prompt.replace(
    /\{\{triggerContext\}\}/g,
    triggerMap[leadContext.triggerType] || 'reached out to you'
  );

  // Lead context
  prompt = prompt.replace(/\{\{leadName\}\}/g, leadContext.leadName);
  prompt = prompt.replace(/\{\{handle\}\}/g, leadContext.handle);
  prompt = prompt.replace(/\{\{platform\}\}/g, leadContext.platform);
  prompt = prompt.replace(/\{\{status\}\}/g, leadContext.status);
  prompt = prompt.replace(/\{\{triggerType\}\}/g, leadContext.triggerType);
  prompt = prompt.replace(
    /\{\{triggerSourceContext\}\}/g,
    leadContext.triggerSource ? ` (from: ${leadContext.triggerSource})` : ''
  );
  prompt = prompt.replace(
    /\{\{qualityScore\}\}/g,
    String(leadContext.qualityScore || 0)
  );

  // Enrichment context
  const enrichmentParts: string[] = [];
  if (leadContext.intentTag) enrichmentParts.push(`- Intent: ${leadContext.intentTag}`);
  if (leadContext.tags?.length) enrichmentParts.push(`- Tags: ${leadContext.tags.join(', ')}`);
  if (leadContext.experience) enrichmentParts.push(`- Experience: ${leadContext.experience}`);
  if (leadContext.incomeLevel) enrichmentParts.push(`- Income Level: ${leadContext.incomeLevel}`);
  if (leadContext.geography) enrichmentParts.push(`- Geography: ${leadContext.geography}`);
  if (leadContext.timezone) enrichmentParts.push(`- Timezone: ${leadContext.timezone}`);
  prompt = prompt.replace(
    /\{\{enrichmentContext\}\}/g,
    enrichmentParts.length > 0 ? enrichmentParts.join('\n') : ''
  );

  // Booking link
  const promptConfig = p.promptConfig as any;
  const bookingLink = promptConfig?.bookingLink || promptConfig?.calendarLink;
  prompt = prompt.replace(
    /\{\{bookingLinkContext\}\}/g,
    bookingLink ? `- Booking link: ${bookingLink}` : ''
  );

  // Qualification flow
  const qualFlow = p.qualificationFlow as any[];
  if (qualFlow?.length) {
    const flowText = qualFlow
      .map((step: any, i: number) => `${i + 1}. ${step.question || step}`)
      .join('\n');
    prompt = prompt.replace(
      /\{\{qualificationFlowContext\}\}/g,
      `\n## QUALIFICATION FLOW\n${flowText}`
    );
  } else {
    prompt = prompt.replace(/\{\{qualificationFlowContext\}\}/g, '');
  }

  // Custom objection handling
  const objHandling = p.objectionHandling as any;
  if (objHandling && typeof objHandling === 'object') {
    const objText = Object.entries(objHandling)
      .map(([key, val]) => `### "${key}"\n- ${val}`)
      .join('\n\n');
    prompt = prompt.replace(
      /\{\{customObjectionContext\}\}/g,
      `\n## CUSTOM OBJECTION HANDLING\n${objText}`
    );
  } else {
    prompt = prompt.replace(/\{\{customObjectionContext\}\}/g, '');
  }

  // Training examples (few-shot)
  if (trainingExamples.length > 0) {
    const exText = trainingExamples
      .map(
        (ex) =>
          `**[${ex.category}]**\nLead: "${ex.leadMessage}"\nIdeal Response: "${ex.idealResponse}"${ex.notes ? `\nNote: ${ex.notes}` : ''}`
      )
      .join('\n\n');
    prompt = prompt.replace(
      /\{\{trainingExamplesContext\}\}/g,
      `\n## TRAINING EXAMPLES\nUse these as reference for tone and style:\n\n${exText}`
    );
  } else {
    prompt = prompt.replace(/\{\{trainingExamplesContext\}\}/g, '');
  }

  // Knowledge assets
  const knowledge = p.knowledgeAssets as any[];
  if (knowledge?.length) {
    const kaText = knowledge
      .map((ka: any) => `### ${ka.title}\n${ka.content}\n*Deploy when: ${ka.deployTrigger || 'relevant'}*`)
      .join('\n\n');
    prompt = prompt.replace(
      /\{\{knowledgeAssetsContext\}\}/g,
      `\n## KNOWLEDGE ASSETS\n${kaText}`
    );
  } else {
    prompt = prompt.replace(/\{\{knowledgeAssetsContext\}\}/g, '');
  }

  // Proof points
  const proofs = p.proofPoints as any[];
  if (proofs?.length) {
    const ppText = proofs
      .map((pp: any) => `- ${pp.name}: ${pp.result} (use when: ${pp.deployContext || 'building credibility'})`)
      .join('\n');
    prompt = prompt.replace(
      /\{\{proofPointsContext\}\}/g,
      `\n## PROOF POINTS / SOCIAL PROOF\n${ppText}`
    );
  } else {
    prompt = prompt.replace(/\{\{proofPointsContext\}\}/g, '');
  }

  // Pre-call sequence
  const preCall = p.preCallSequence as any[];
  if (preCall?.length) {
    const pcText = preCall
      .map((step: any) => `- ${step.timing}: "${step.message}"`)
      .join('\n');
    prompt = prompt.replace(
      /\{\{preCallSequenceContext\}\}/g,
      `\n## PRE-CALL NURTURE SEQUENCE\n${pcText}`
    );
  } else {
    prompt = prompt.replace(/\{\{preCallSequenceContext\}\}/g, '');
  }

  // Custom phrases
  const phrases = p.customPhrases as any;
  if (phrases && typeof phrases === 'object') {
    const cpText = Object.entries(phrases)
      .map(([key, val]) => `- ${key}: "${val}"`)
      .join('\n');
    prompt = prompt.replace(
      /\{\{customPhrasesContext\}\}/g,
      `\n## CUSTOM PHRASES\nUse these naturally in your messages:\n${cpText}`
    );
  } else {
    prompt = prompt.replace(/\{\{customPhrasesContext\}\}/g, '');
  }

  // If the persona has a custom system prompt override, prepend it
  if (p.systemPrompt && p.systemPrompt.trim().length > 100) {
    prompt = p.systemPrompt + '\n\n---\n\n' + prompt;
  }

  return prompt;
}

/**
 * Get the current system prompt version for an account (for tracking).
 */
export async function getPromptVersion(accountId: string): Promise<string> {
  const latestVersion = await prisma.promptVersion.findFirst({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    select: { version: true }
  });
  return latestVersion?.version || '1.0.0';
}
