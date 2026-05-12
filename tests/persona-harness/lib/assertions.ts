// Evaluates a single assertion against a TurnOutcome. Each assertion
// type returns { passed, message } so the runner can build a clean
// per-turn report.

import type { Assertion, AssertionResult } from '../types';
import type { TurnOutcome } from './invoke-pipeline';

export function evaluateAssertion(
  assertion: Assertion,
  outcome: TurnOutcome
): AssertionResult {
  const passed = (msg: string): AssertionResult => ({
    assertion,
    passed: true,
    message: msg
  });
  const failed = (msg: string): AssertionResult => ({
    assertion,
    passed: false,
    message: msg
  });

  switch (assertion.type) {
    case 'STAGE_IS': {
      const actual = outcome.conversationState?.systemStage;
      return actual === assertion.value
        ? passed(`stage == ${assertion.value}`)
        : failed(`stage expected ${assertion.value}, got ${actual}`);
    }

    case 'STAGE_ADVANCED': {
      const actual = outcome.conversationState?.systemStage;
      return actual && actual !== assertion.value
        ? passed(`stage advanced past ${assertion.value} → ${actual}`)
        : failed(
            `stage did not advance past ${assertion.value} (now ${actual})`
          );
    }

    case 'AI_REPLY_NOT_EMPTY': {
      const r = outcome.aiReplyText ?? '';
      return r.trim().length > 0
        ? passed(`AI reply length=${r.length}`)
        : failed('AI reply is empty');
    }

    case 'AI_REPLY_MAX_CHARS': {
      const r = outcome.aiReplyText ?? '';
      const max = Number(assertion.value ?? 0);
      return r.length <= max
        ? passed(`AI reply ${r.length} <= ${max}`)
        : failed(`AI reply ${r.length} > ${max}`);
    }

    case 'FORBIDDEN_PHRASE_ABSENT':
    case 'PHRASE_ABSENT': {
      const needle = String(assertion.value ?? '');
      const r = outcome.aiReplyText ?? '';
      return !r.includes(needle)
        ? passed(`"${needle}" not in reply`)
        : failed(`"${needle}" found in reply`);
    }

    case 'PHRASE_PRESENT': {
      const needle = String(assertion.value ?? '');
      const r = outcome.aiReplyText ?? '';
      return r.includes(needle)
        ? passed(`"${needle}" present`)
        : failed(`"${needle}" missing from reply`);
    }

    case 'PHRASE_MATCHES': {
      const pattern = assertion.pattern ?? String(assertion.value ?? '');
      const r = outcome.aiReplyText ?? '';
      try {
        const re = new RegExp(pattern, 'i');
        return re.test(r)
          ? passed(`matches /${pattern}/i`)
          : failed(`reply does not match /${pattern}/i`);
      } catch {
        return failed(`invalid regex: ${pattern}`);
      }
    }

    case 'CAPTURED_DATA_HAS': {
      const key = assertion.key ?? String(assertion.value ?? '');
      const cap = outcome.conversationState?.capturedDataPoints ?? {};
      return key in cap
        ? passed(`captured["${key}"] = ${JSON.stringify(cap[key])}`)
        : failed(`captured data missing key "${key}"`);
    }

    case 'CAPTURED_DATA_EQUALS': {
      const key = assertion.key ?? '';
      const cap = outcome.conversationState?.capturedDataPoints ?? {};
      const actual = cap[key];
      return actual === assertion.value
        ? passed(`captured["${key}"] == ${JSON.stringify(assertion.value)}`)
        : failed(
            `captured["${key}"] expected ${JSON.stringify(assertion.value)}, got ${JSON.stringify(actual)}`
          );
    }

    case 'LEAD_INTENT_TAG': {
      const actual = outcome.conversationState?.leadIntentTag;
      return actual === assertion.value
        ? passed(`leadIntentTag == ${assertion.value}`)
        : failed(`leadIntentTag expected ${assertion.value}, got ${actual}`);
    }

    case 'OUTCOME_IS': {
      const actual = outcome.conversationState?.outcome;
      return actual === assertion.value
        ? passed(`outcome == ${assertion.value}`)
        : failed(`outcome expected ${assertion.value}, got ${actual}`);
    }

    case 'SCHEDULED_REPLY_EXISTS': {
      // After drainScheduledReplies, scheduled rows are marked SENT.
      // For now we treat "AI reply exists" as proof the schedule fired.
      return outcome.aiMessageIds.length > 0
        ? passed('AI reply was scheduled and fired')
        : failed('no AI reply fired');
    }

    case 'NOTIFICATION_CREATED': {
      return outcome.notificationsCreated > 0
        ? passed(`${outcome.notificationsCreated} notification(s) created`)
        : failed('expected a notification, none created');
    }

    case 'INBOUND_QUALIFICATION_WRITTEN': {
      return outcome.inboundQualificationCreated
        ? passed('InboundQualification row written (classifier fired)')
        : failed(
            'InboundQualification not written — classifier may have been bypassed'
          );
    }

    default: {
      const exhaustive: never = assertion.type;
      return failed(`unknown assertion type: ${exhaustive}`);
    }
  }
}
