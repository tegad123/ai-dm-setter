// Evaluates a single assertion against a TurnOutcome + scenario
// context (persona URL allowlist). Each handler returns
// { passed, message } so the runner can build a clean per-turn report.

import type { Assertion, AssertionResult } from '../types';
import type { TurnOutcome } from './invoke-pipeline';

export interface AssertionContext {
  allowedUrls: string[];
}

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const TEMPLATE_LEAK_PATTERNS: RegExp[] = [
  /\{\{[^}]+\}\}/,
  /\$\{[^}]+\}/,
  /<<[A-Z_]+>>/,
  /\[\[[A-Z_]+\]\]/,
  /\bundefined\b/i
];

function dataPointValue(
  cap: Record<string, unknown> | null,
  key: string
): unknown {
  if (!cap) return undefined;
  const raw = cap[key];
  if (raw && typeof raw === 'object' && 'value' in (raw as object)) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

function dataPointExists(
  cap: Record<string, unknown> | null,
  key: string
): boolean {
  if (!cap) return false;
  if (!(key in cap)) return false;
  const v = dataPointValue(cap, key);
  return v !== undefined && v !== null;
}

function extractUrls(text: string | null): string[] {
  if (!text) return [];
  return text.match(URL_REGEX) ?? [];
}

function urlMatchesAllowed(url: string, allowed: string[]): boolean {
  return allowed.some((a) => url === a || url.startsWith(a));
}

function findBranchEvents(
  outcome: TurnOutcome,
  step: number
): Array<Record<string, unknown>> {
  const history = outcome.branchHistory ?? [];
  return history.filter((e) => e && e['stepNumber'] === step);
}

export function evaluateAssertion(
  assertion: Assertion,
  outcome: TurnOutcome,
  ctx: AssertionContext = { allowedUrls: [] }
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

  const reply = outcome.aiReplyText ?? '';
  const cap = outcome.conversationState?.capturedDataPoints ?? null;
  const key = assertion.key ?? assertion.field ?? '';

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

    case 'STEP_IS': {
      const actual = outcome.conversationState?.currentScriptStep;
      return actual === assertion.value
        ? passed(`step == ${assertion.value}`)
        : failed(`step expected ${assertion.value}, got ${actual}`);
    }

    case 'STEP_REACHED': {
      const actual = outcome.conversationState?.currentScriptStep ?? -1;
      const target = Number(assertion.value);
      if (actual >= target)
        return passed(`step reached ${target} (now ${actual})`);
      // Fallback: branchHistory shows the step was at least visited
      const hist = outcome.branchHistory ?? [];
      const visited = hist.some((e) => Number(e['stepNumber']) >= target);
      return visited
        ? passed(
            `step ${target} visited in branchHistory (currentStep=${actual})`
          )
        : failed(`step ${target} not reached (currentStep=${actual})`);
    }

    case 'AI_REPLY_NOT_EMPTY': {
      return reply.trim().length > 0
        ? passed(`AI reply length=${reply.length}`)
        : failed('AI reply is empty');
    }

    case 'AI_REPLY_MAX_CHARS': {
      const max = Number(assertion.value ?? 0);
      return reply.length <= max
        ? passed(`AI reply ${reply.length} <= ${max}`)
        : failed(`AI reply ${reply.length} > ${max}`);
    }

    case 'FORBIDDEN_PHRASE_ABSENT':
    case 'PHRASE_ABSENT': {
      const needle = String(assertion.value ?? '');
      return !reply.toLowerCase().includes(needle.toLowerCase())
        ? passed(`"${needle}" not in reply`)
        : failed(`"${needle}" found in reply`);
    }

    case 'PHRASE_PRESENT':
    case 'AI_MESSAGE_CONTAINS': {
      const needle = String(assertion.value ?? '');
      return reply.toLowerCase().includes(needle.toLowerCase())
        ? passed(`"${needle}" present`)
        : failed(`"${needle}" missing from reply`);
    }

    case 'PHRASE_MATCHES': {
      const pattern = assertion.pattern ?? String(assertion.value ?? '');
      try {
        const re = new RegExp(pattern, 'i');
        return re.test(reply)
          ? passed(`matches /${pattern}/i`)
          : failed(`reply does not match /${pattern}/i`);
      } catch {
        return failed(`invalid regex: ${pattern}`);
      }
    }

    case 'CAPTURED_DATA_HAS': {
      return dataPointExists(cap, key)
        ? passed(
            `captured["${key}"] = ${JSON.stringify(dataPointValue(cap, key))}`
          )
        : failed(`captured data missing key "${key}"`);
    }

    case 'CAPTURED_DATA_EQUALS':
    case 'CAPTURED_DATA_VALUE': {
      const actual = dataPointValue(cap, key);
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
      return outcome.aiMessageIds.length > 0
        ? passed('AI reply was scheduled and fired')
        : failed('no AI reply fired');
    }

    case 'NOTIFICATION_CREATED': {
      return outcome.notificationsCreated > 0
        ? passed(`${outcome.notificationsCreated} notification(s) created`)
        : failed('expected a notification, none created');
    }

    case 'NO_QUALITY_GATE_FAILURE': {
      if (outcome.qualityGateFailed) {
        return failed('quality gate threw a QualityGateEscalationError');
      }
      // notificationsCreated covers prod escalation rows
      return outcome.notificationsCreated === 0
        ? passed('no quality-gate failure on this turn')
        : failed(
            `${outcome.notificationsCreated} notification(s) created — quality gate likely escalated`
          );
    }

    case 'NO_TEMPLATE_LEAK': {
      const hits = TEMPLATE_LEAK_PATTERNS.filter((p) => p.test(reply));
      return hits.length === 0
        ? passed('no template-leak patterns in reply')
        : failed(`template leak: ${hits.map((p) => p.source).join(', ')}`);
    }

    case 'NO_FABRICATED_URL': {
      const urls = extractUrls(reply);
      if (urls.length === 0) return passed('no URLs in reply');
      if (ctx.allowedUrls.length === 0) {
        return failed(
          `reply has URLs but persona has no allowlist configured: ${urls.join(', ')}`
        );
      }
      const bad = urls.filter((u) => !urlMatchesAllowed(u, ctx.allowedUrls));
      return bad.length === 0
        ? passed(`all URLs allowlisted (${urls.length})`)
        : failed(`fabricated URL(s): ${bad.join(', ')}`);
    }

    case 'LINK_SENT': {
      const needle = assertion.urlContains ?? String(assertion.value ?? '');
      const urls = extractUrls(reply);
      const hit = urls.find((u) => u.includes(needle));
      return hit
        ? passed(`link sent: ${hit}`)
        : failed(`no URL containing "${needle}" found in reply`);
    }

    case 'BRANCH_SELECTED': {
      const step = Number(assertion.step ?? -1);
      const target = String(assertion.value ?? '');
      const events = findBranchEvents(outcome, step);
      const hit = events.find(
        (e) =>
          String(e['selectedBranchLabel'] ?? '')
            .toLowerCase()
            .includes(target.toLowerCase()) ||
          String(e['currentSelectedBranch'] ?? '')
            .toLowerCase()
            .includes(target.toLowerCase())
      );
      return hit
        ? passed(`branch "${target}" selected at step ${step}`)
        : failed(
            `branch "${target}" not selected at step ${step} (events: ${events.length})`
          );
    }

    case 'BRANCH_HISTORY_HAS_EVENT': {
      const step = Number(assertion.step ?? -1);
      const requested = String(assertion.eventType ?? '').toLowerCase();
      const events = findBranchEvents(outcome, step);
      const matchers = (e: Record<string, unknown>): boolean => {
        const et = String(e['eventType'] ?? '').toLowerCase();
        if (et === requested) return true;
        // Alias: 'step_skipped' -> a conditional_skip_decision that chose skip
        if (
          requested === 'step_skipped' &&
          et === 'conditional_skip_decision' &&
          String(e['skipDecision'] ?? '') === 'skip'
        ) {
          return true;
        }
        return false;
      };
      const hit = events.find(matchers);
      return hit
        ? passed(`branchHistory has ${requested} at step ${step}`)
        : failed(
            `branchHistory missing ${requested} at step ${step} (${events.length} event(s) at that step)`
          );
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
