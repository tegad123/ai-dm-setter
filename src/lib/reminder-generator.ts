// ---------------------------------------------------------------------------
// reminder-generator.ts
// ---------------------------------------------------------------------------
// Generates the body text for a scheduled call reminder at fire time.
// Uses the existing ai-engine generateReply() so voice / stage / voice-
// quality-gate all still apply, with an extra system-prompt appendix that
// tells the LLM this is a reminder nudge rather than a direct reply.
// ---------------------------------------------------------------------------

import type { ScheduledMessageType } from '@prisma/client';

/**
 * Returns a system-prompt appendix that describes the reminder context.
 * Appended to the standard system prompt so the LLM stays in the account's
 * voice while producing a short, natural check-in message.
 */
export function buildReminderPromptAppendix(params: {
  messageType: ScheduledMessageType;
  scheduledCallAt: Date | null;
  scheduledCallTimezone: string | null;
  leadName: string;
}): string {
  const { messageType, scheduledCallAt, scheduledCallTimezone, leadName } =
    params;

  // Format the call time in the lead's timezone if we have one
  const callLabel = scheduledCallAt
    ? formatCallInTz(scheduledCallAt, scheduledCallTimezone)
    : '(no time set)';

  const commonRules = `
Rules for this message:
- Short and natural — treat it like a real person checking in, not a marketing blast.
- ONE sentence or two at most. No multi-part walls of text.
- Do not re-pitch, do not re-qualify, do not ask a bunch of questions.
- Keep the lead's name casual (lowercase, just first name if known).
- Respect all voice rules from the main prompt (lowercase opener, no banned emojis, no em-dashes, no "sales call" wording).
- Set stage to the CURRENT stage the conversation is in, don't invent one.
- Set sub_stage to null unless you're clearly in a booking sub-stage.`;

  switch (messageType) {
    case 'DAY_BEFORE_REMINDER':
      return `\n\n## REMINDER CONTEXT (CRITICAL — READ LAST)
You are generating a DAY-BEFORE call reminder for ${leadName}. Their call is ${callLabel}. This is a friendly heads-up the day before — remind them the call is tomorrow and show you're excited about it. Natural, warm, in the account owner's voice. Do NOT include any links or meeting URLs — the booking email already has those. If you don't know the exact time, say something generic like "excited for the call tomorrow" instead of making up a time.
${commonRules}`;

    case 'MORNING_OF_REMINDER':
      return `\n\n## REMINDER CONTEXT (CRITICAL — READ LAST)
You are generating a MORNING-OF call reminder for ${leadName}. Their call is ${callLabel}. This is a same-day nudge — a quick "looking forward to talking later today" type message. Light, warm, no pressure. Do NOT include links or meeting URLs. Do NOT ask if they'll make it (that reads as doubting them); assume they're showing up.
${commonRules}`;

    case 'WINDOW_KEEPALIVE':
      return `\n\n## REMINDER CONTEXT (CRITICAL — READ LAST)
You are generating a MESSAGING-WINDOW KEEPALIVE for ${leadName}. The lead hasn't replied in around 20 hours and the Meta messaging window is about to close. Generate ONE short natural check-in that gives them a reason to respond. Reference the context of the prior conversation if helpful. Do NOT pitch, do NOT pressure, do NOT re-qualify. Warm, friendly, low-stakes.
${commonRules}`;

    case 'RE_ENGAGEMENT':
      return `\n\n## REMINDER CONTEXT (CRITICAL — READ LAST)
You are generating a RE-ENGAGEMENT touch for ${leadName}. The conversation has been quiet for a while. Reach back out naturally with a low-pressure check-in. Reference specifics from earlier if they help.
${commonRules}`;

    case 'CUSTOM':
    default:
      return `\n\n## REMINDER CONTEXT (CRITICAL — READ LAST)
You are generating a scheduled outbound touch for ${leadName}.
${commonRules}`;
  }
}

function formatCallInTz(d: Date, tz: string | null): string {
  try {
    return (
      d.toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: tz || 'UTC',
        timeZoneName: 'short'
      }) + (tz ? '' : ' UTC')
    );
  } catch {
    return d.toISOString();
  }
}
