import type {
  AssertionResult,
  ConversationFixture,
  FixturePersonaConfig
} from './types';

import {
  detectMetadataLeak,
  surgicalStripMetadataLeak,
  acknowledgesEmotionally,
  isExplicitAcceptance,
  replyDeliversArtifact,
  containsCallPitch,
  containsCallOrBookingAdvancement,
  containsLogisticsQuestion,
  containsCapitalQuestion,
  callLogisticsAlreadyDeliveredInRecentHistory,
  getUnacknowledgedLeadBurst,
  scoreVoiceQualityGroup
} from '../../src/lib/voice-quality-gate';

import { extractCapturedDataPointsForTest } from '../../src/lib/script-state-recovery';
import { detectBookingAdvancementDetails } from '../../src/lib/ai-engine';

const URL_REGEX = /\bhttps?:\/\/[^\s)>\]"']+/gi;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function urlsIn(text: string): string[] {
  return Array.from(text.matchAll(URL_REGEX)).map((m) =>
    m[0].replace(/[.,;:!?)\]]+$/, '')
  );
}

function fixtureHistoryToScriptHistory(fixture: ConversationFixture) {
  const base = Date.now();
  return fixture.conversationHistory.map((m, i) => ({
    sender: m.sender,
    content: m.content,
    timestamp: new Date(
      base - (fixture.conversationHistory.length - i) * 60_000
    )
  }));
}

function lastReplyAvailable(fixture: ConversationFixture): string {
  if (!fixture.recordedAssistantReply) {
    throw new Error(
      `Fixture ${fixture.id} requires recordedAssistantReply for assertion type ${fixture.assertion.type}`
    );
  }
  return fixture.recordedAssistantReply;
}

function urlForField(
  persona: FixturePersonaConfig | undefined,
  field: 'freeValueLink' | 'downsellLink' | 'bookingTypeformUrl' | undefined
): string | null {
  if (!persona || !field) return null;
  return persona[field] ?? null;
}

function applyMetadataStripIfNeeded(text: string): {
  cleaned: string;
  notes: string;
} {
  const leak = detectMetadataLeak(text);
  if (!leak.leak || !leak.matchedText) {
    return { cleaned: text, notes: 'no metadata leak detected' };
  }
  const strip = surgicalStripMetadataLeak(text, leak.matchedText);
  if (!strip.success) {
    // Gate would hard-fail and trigger regeneration in real pipeline;
    // for fixture purposes, surface the unstripped text so the caller's
    // forbidden-phrase check naturally fails.
    return {
      cleaned: text,
      notes: `metadata leak detected ("${leak.matchedText}") but strip failed`
    };
  }
  return {
    cleaned: strip.content,
    notes: `metadata leak detected and stripped via R34 gate`
  };
}

function checkForbiddenPhrasesAbsent(
  text: string,
  fixture: ConversationFixture
): AssertionResult {
  const { cleaned, notes } = applyMetadataStripIfNeeded(text);
  const phrases = fixture.assertion.forbiddenPhrases ?? [];
  const patterns = fixture.assertion.forbiddenPatterns ?? [];
  const phraseHits = phrases.filter((p) =>
    new RegExp(escapeRegex(p), 'i').test(cleaned)
  );
  const patternHits = patterns.filter((p) => p.test(cleaned));
  if (phraseHits.length === 0 && patternHits.length === 0) {
    return {
      passed: true,
      evidence: `no forbidden phrases or patterns matched (${notes})`
    };
  }
  return {
    passed: false,
    evidence: `forbidden hits: phrases=${JSON.stringify(phraseHits)} patterns=${patternHits
      .map((p) => p.source)
      .join('|')} (${notes})`
  };
}

function checkForbiddenPattern(
  text: string,
  fixture: ConversationFixture
): AssertionResult {
  // Reuse forbidden phrase machinery; metadata leak adds the gate detector.
  const phrases = fixture.assertion.forbiddenPhrases ?? [];
  const patterns = fixture.assertion.forbiddenPatterns ?? [];
  const phraseHits = phrases.filter((p) =>
    new RegExp(escapeRegex(p), 'i').test(text)
  );
  const patternHits = patterns.filter((p) => p.test(text));
  const leak = detectMetadataLeak(text);
  if (phraseHits.length === 0 && patternHits.length === 0 && !leak.leak) {
    return { passed: true, evidence: 'clean: no leak, no forbidden patterns' };
  }
  return {
    passed: false,
    evidence: `leak=${leak.leak ? leak.matchedText : 'none'}; phrases=${JSON.stringify(
      phraseHits
    )}; patterns=${patternHits.map((p) => p.source).join('|')}`
  };
}

export function runAssertion(fixture: ConversationFixture): AssertionResult {
  const a = fixture.assertion;
  switch (a.type) {
    case 'FORBIDDEN_PHRASE_ABSENT': {
      const reply = lastReplyAvailable(fixture);
      return checkForbiddenPhrasesAbsent(reply, fixture);
    }

    case 'REQUIRED_URL_PRESENT': {
      const reply = lastReplyAvailable(fixture);
      const url = urlForField(fixture.personaConfig, a.requiredUrlField);
      if (!url) {
        return {
          passed: false,
          evidence: `personaConfig.${a.requiredUrlField} not set`
        };
      }
      const present = reply.includes(url);
      const delivers = replyDeliversArtifact(reply);
      return present && delivers
        ? {
            passed: true,
            evidence: `reply contains ${url} and replyDeliversArtifact=true`
          }
        : {
            passed: false,
            evidence: `present=${present} delivers=${delivers}; reply="${reply.slice(0, 120)}..."`
          };
    }

    case 'URL_ALLOWLIST_CHECK': {
      const reply = lastReplyAvailable(fixture);
      const allowed = (a.allowedUrlFields ?? [])
        .map((f) => urlForField(fixture.personaConfig, f))
        .filter((u): u is string => Boolean(u));
      const found = urlsIn(reply);
      const unauthorized = found.filter(
        (u) => !allowed.some((allow) => u.startsWith(allow))
      );
      return unauthorized.length === 0
        ? {
            passed: true,
            evidence: `all URLs allowlisted: ${JSON.stringify(found)}`
          }
        : {
            passed: false,
            evidence: `unauthorized URLs: ${JSON.stringify(unauthorized)}; allowed: ${JSON.stringify(allowed)}`
          };
    }

    case 'STAGE_CHECK': {
      const points = extractCapturedDataPointsForTest({
        existing: null,
        history: fixtureHistoryToScriptHistory(fixture),
        minimumCapitalRequired:
          fixture.personaConfig?.minimumCapitalRequired ?? null
      });
      const stage = fixture.systemStage ?? 'UNKNOWN';
      const forbidden = a.forbiddenStages ?? [];
      const expected = a.expectedStage;
      // Stage classification: rely on caller-supplied systemStage.
      // Forbidden-stage detection is the primary regression check here.
      if (forbidden.includes(stage)) {
        return {
          passed: false,
          evidence: `stage="${stage}" matched forbidden list ${JSON.stringify(forbidden)}; capitalThresholdMet=${
            points.capitalThresholdMet?.value ?? 'null'
          }`
        };
      }
      if (expected && stage !== expected) {
        return {
          passed: false,
          evidence: `stage="${stage}" expected "${expected}"`
        };
      }
      return {
        passed: true,
        evidence: `stage="${stage}" capitalThresholdMet=${
          points.capitalThresholdMet?.value ?? 'null'
        }`
      };
    }

    case 'DATA_POINT_CAPTURED': {
      const history = fixtureHistoryToScriptHistory({
        ...fixture,
        conversationHistory: [
          ...fixture.conversationHistory,
          { sender: 'LEAD', content: fixture.lastLeadMessage }
        ]
      });
      const points = extractCapturedDataPointsForTest({
        existing: null,
        history,
        minimumCapitalRequired:
          fixture.personaConfig?.minimumCapitalRequired ?? null
      });
      const key = a.expectedDataPoint?.key;
      if (!key) {
        return {
          passed: false,
          evidence: 'expectedDataPoint.key not configured on fixture'
        };
      }
      const dp = points[key];
      if (a.expectedDataPoint?.notNull && !dp) {
        return {
          passed: false,
          evidence: `${key} not captured; full points=${JSON.stringify(points)}`
        };
      }
      if (
        a.expectedDataPoint?.equals !== undefined &&
        dp?.value !== a.expectedDataPoint.equals
      ) {
        return {
          passed: false,
          evidence: `${key}=${JSON.stringify(dp?.value)} expected ${JSON.stringify(
            a.expectedDataPoint.equals
          )}`
        };
      }
      return {
        passed: true,
        evidence: `${key}=${JSON.stringify(dp?.value)}`
      };
    }

    case 'STAGE_ADVANCE': {
      // Stage advance is ultimately the absence of a re-ask + the
      // affirmative capital extraction. Combine: capitalThresholdMet
      // captured AND recordedAssistantReply (if provided) does not
      // re-ask the same question.
      const history = fixtureHistoryToScriptHistory({
        ...fixture,
        conversationHistory: [
          ...fixture.conversationHistory,
          { sender: 'LEAD', content: fixture.lastLeadMessage }
        ]
      });
      const points = extractCapturedDataPointsForTest({
        existing: null,
        history,
        minimumCapitalRequired:
          fixture.personaConfig?.minimumCapitalRequired ?? null
      });
      const captured = points.capitalThresholdMet?.value;
      if (captured !== true) {
        return {
          passed: false,
          evidence: `capitalThresholdMet=${JSON.stringify(captured)} (expected true)`
        };
      }
      if (fixture.recordedAssistantReply) {
        const forbidden = checkForbiddenPhrasesAbsent(
          fixture.recordedAssistantReply,
          fixture
        );
        if (!forbidden.passed) return forbidden;
      }
      return {
        passed: true,
        evidence: `capitalThresholdMet=true and no re-ask phrases detected`
      };
    }

    case 'CONVERSATION_CONTINUES': {
      const reply = fixture.recordedAssistantReply;
      if (!reply || reply.trim().length === 0) {
        return {
          passed: false,
          evidence: 'no reply generated — conversation went dark'
        };
      }
      const forbidden = checkForbiddenPhrasesAbsent(reply, fixture);
      if (!forbidden.passed) return forbidden;
      return {
        passed: true,
        evidence: 'reply present, no forbidden phrases'
      };
    }

    case 'RESPONSE_GENERATED': {
      const reply = fixture.recordedAssistantReply;
      if (!reply || reply.trim().length === 0) {
        return {
          passed: false,
          evidence: 'no reply generated within window'
        };
      }
      return {
        passed: true,
        evidence: `reply length ${reply.length} chars`
      };
    }

    case 'TOPIC_ACKNOWLEDGED': {
      const reply = lastReplyAvailable(fixture);
      const keywords = a.topicKeywords ?? [];
      const hits = keywords.filter((k) =>
        new RegExp(`\\b${escapeRegex(k)}`, 'i').test(reply)
      );
      return hits.length > 0
        ? {
            passed: true,
            evidence: `topic keywords matched: ${JSON.stringify(hits)}`
          }
        : {
            passed: false,
            evidence: `none of ${JSON.stringify(keywords)} present in reply: "${reply.slice(0, 160)}..."`
          };
    }

    case 'BURST_ACKNOWLEDGED': {
      const reply = lastReplyAvailable(fixture);
      const keywords = a.topicKeywords ?? [];
      const keywordHit = keywords.some((k) =>
        new RegExp(`\\b${escapeRegex(k)}`, 'i').test(reply)
      );
      const emotional = acknowledgesEmotionally(reply);
      // Verify the burst itself was unacknowledged (sanity: the gate
      // would have flagged this in production).
      const allMessages = [
        ...fixture.conversationHistory,
        { sender: 'LEAD' as const, content: fixture.lastLeadMessage }
      ];
      const burst = getUnacknowledgedLeadBurst(
        allMessages.map((m) => ({ sender: m.sender, content: m.content }))
      );
      if (keywordHit || emotional) {
        return {
          passed: true,
          evidence: `keywordHit=${keywordHit} emotional=${emotional} burstSize=${burst?.messages.length ?? 0}`
        };
      }
      return {
        passed: false,
        evidence: `no keyword nor emotional ack; burstSize=${burst?.messages.length ?? 0}; reply="${reply.slice(0, 160)}..."`
      };
    }

    case 'CORRECT_ROUTE': {
      const reply = lastReplyAvailable(fixture);
      const route = a.expectedRoute;
      const downsellUrl = fixture.personaConfig?.downsellLink ?? null;
      const bookingUrl = fixture.personaConfig?.bookingTypeformUrl ?? null;
      const forbiddenPhrases = a.forbiddenRoutePhrases ?? [];
      const forbiddenHit = forbiddenPhrases.find((p) =>
        new RegExp(escapeRegex(p), 'i').test(reply)
      );
      if (forbiddenHit) {
        return {
          passed: false,
          evidence: `wrong-route phrase present: "${forbiddenHit}"`
        };
      }
      if (route === 'downsell') {
        if (!downsellUrl) {
          return {
            passed: false,
            evidence:
              'personaConfig.downsellLink missing — cannot verify downsell route'
          };
        }
        return reply.includes(downsellUrl)
          ? { passed: true, evidence: `routed to downsell (${downsellUrl})` }
          : {
              passed: false,
              evidence: `expected downsell URL ${downsellUrl} in reply`
            };
      }
      if (route === 'booking') {
        if (!bookingUrl) {
          return {
            passed: false,
            evidence: 'personaConfig.bookingTypeformUrl missing'
          };
        }
        return reply.includes(bookingUrl)
          ? { passed: true, evidence: `routed to booking (${bookingUrl})` }
          : {
              passed: false,
              evidence: `expected booking URL ${bookingUrl} in reply`
            };
      }
      return {
        passed: true,
        evidence: `route=${route}; no forbidden phrases hit`
      };
    }

    case 'PREREQUISITE_GATE_ENFORCED': {
      const reply = lastReplyAvailable(fixture);
      const pitched =
        containsCallPitch(reply) || containsCallOrBookingAdvancement(reply);
      const hasLogistics = containsLogisticsQuestion(reply);
      // The bug: AI offers the call/booking before capital is captured.
      // Forbidden: pitch present when capitalAsked is false.
      const capitalAlreadyCaptured =
        fixture.capturedDataPoints &&
        (fixture.capturedDataPoints as Record<string, unknown>)[
          'capitalThresholdMet'
        ];
      if (!capitalAlreadyCaptured && pitched) {
        return {
          passed: false,
          evidence: `soft pitch fired before capital captured: pitch=${pitched} logistics=${hasLogistics}`
        };
      }
      return {
        passed: true,
        evidence: `pitch=${pitched} logistics=${hasLogistics} capitalCaptured=${Boolean(capitalAlreadyCaptured)}`
      };
    }

    case 'ACCEPTANCE_HONORED': {
      const reply = lastReplyAvailable(fixture);
      const accepted = isExplicitAcceptance(fixture.lastLeadMessage);
      const url = urlForField(
        fixture.personaConfig,
        a.acceptanceMustDeliverField
      );
      if (!accepted) {
        return {
          passed: false,
          evidence: `lastLeadMessage not detected as acceptance — fixture mis-specified`
        };
      }
      if (!url) {
        return {
          passed: false,
          evidence: `personaConfig.${a.acceptanceMustDeliverField} not set`
        };
      }
      return reply.includes(url)
        ? { passed: true, evidence: `acceptance honored — ${url} delivered` }
        : {
            passed: false,
            evidence: `acceptance NOT honored — ${url} missing from reply`
          };
    }

    case 'INTENT_DEDUP_ENFORCED': {
      const reply = lastReplyAvailable(fixture);
      const intentPatterns = a.intentMatchPatterns ?? [];
      // Reply must NOT match any intent pattern that already fired in
      // a prior AI message in the history.
      const priorAiHits = fixture.conversationHistory
        .filter((m) => m.sender === 'AI')
        .filter((m) => intentPatterns.some((p) => p.test(m.content)));
      if (priorAiHits.length === 0) {
        return {
          passed: false,
          evidence: `no prior AI message matched any intent pattern — fixture mis-specified`
        };
      }
      const replyHit = intentPatterns.find((p) => p.test(reply));
      if (replyHit) {
        return {
          passed: false,
          evidence: `intent re-asked: pattern ${replyHit.source} matched after prior AI message already covered it`
        };
      }
      return {
        passed: true,
        evidence: `prior intent (${priorAiHits.length} prior msg(s)) not re-asked`
      };
    }

    case 'POSITIVE_ACKNOWLEDGED': {
      const reply = lastReplyAvailable(fixture);
      const keywords = a.topicKeywords ?? [];
      const keywordHit = keywords.some((k) =>
        new RegExp(`\\b${escapeRegex(k)}`, 'i').test(reply)
      );
      const emotional = acknowledgesEmotionally(reply);
      if (!reply.trim()) {
        return {
          passed: false,
          evidence: 'no reply — silent stop'
        };
      }
      if (keywordHit || emotional) {
        return {
          passed: true,
          evidence: `positive ack present: keyword=${keywordHit} emotional=${emotional}`
        };
      }
      return {
        passed: false,
        evidence: `no positive acknowledgment in reply: "${reply.slice(0, 160)}..."`
      };
    }

    case 'MANYCHAT_STAGE_SKIP_BLOCKED': {
      const reply = lastReplyAvailable(fixture);
      const blockedDraft = fixture.blockedDraftReply;
      if (!blockedDraft) {
        return {
          passed: false,
          evidence: 'blockedDraftReply missing — cannot verify hardfail gate'
        };
      }

      const priorAi = [...fixture.conversationHistory]
        .reverse()
        .find((m) => m.sender === 'AI');
      const quality = scoreVoiceQualityGroup([blockedDraft], {
        conversationSource: fixture.source ?? 'MANYCHAT',
        aiMessageCount: fixture.aiMessageCount ?? 2,
        capturedDataPoints: fixture.capturedDataPoints ?? {},
        previousAIMessage: priorAi?.content ?? null,
        previousLeadMessage: fixture.lastLeadMessage
      });
      const gateFired = quality.hardFails.some((f) =>
        f.includes('manychat_early_capital_question:')
      );
      if (!gateFired) {
        return {
          passed: false,
          evidence: `capital draft was not blocked; hardFails=${JSON.stringify(quality.hardFails)}`
        };
      }

      if (containsCapitalQuestion(reply)) {
        return {
          passed: false,
          evidence: `corrected reply still contains a capital question: "${reply}"`
        };
      }

      const asksDiscovery =
        /\?/.test(reply) &&
        /\b(trading background|trading experience|experience|how long|been trading|trade)\b/i.test(
          reply
        );
      if (!asksDiscovery) {
        return {
          passed: false,
          evidence: `corrected reply does not ask discovery: "${reply}"`
        };
      }

      return {
        passed: true,
        evidence:
          'ManyChat capital draft hard-failed; corrected reply asks discovery and contains no capital question'
      };
    }

    case 'POST_CAPITAL_CLARIFIER_ENFORCED': {
      const reply = lastReplyAvailable(fixture);
      const blockedDraft = fixture.blockedDraftReply;
      if (!blockedDraft) {
        return {
          passed: false,
          evidence: 'blockedDraftReply missing — cannot verify detector reason'
        };
      }

      const priorAi = [...fixture.conversationHistory]
        .reverse()
        .find((m) => m.sender === 'AI');
      const priorWasCapitalAsk = priorAi
        ? containsCapitalQuestion(priorAi.content)
        : false;
      if (!priorWasCapitalAsk) {
        return {
          passed: false,
          evidence: 'fixture prior AI turn was not detected as a capital ask'
        };
      }

      const decision = detectBookingAdvancementDetails(
        {
          message: blockedDraft,
          messages: [blockedDraft],
          stage: fixture.blockedDraftStage ?? 'URGENCY',
          subStage: null
        } as never,
        {
          prevAiTurnWasCapitalAsk: true,
          capitalVerified: false
        }
      );
      if (
        !decision.advancement ||
        ![
          'post_capital_non_numeric_pivot',
          'capital_not_verified_before_advancement'
        ].includes(decision.reason ?? '')
      ) {
        return {
          passed: false,
          evidence: `blocked draft did not map to an audit block reason; decision=${JSON.stringify(decision)}`
        };
      }

      const forbiddenUrgency =
        /(how soon|trying to make|make this happen)/i.test(reply);
      const pinsDollarFigure =
        /\?/.test(reply) &&
        /\b(cash|dollar|amount|liquid|set aside|ready to deploy|working with|how much|roughly)\b/i.test(
          reply
        );
      if (forbiddenUrgency || !pinsDollarFigure) {
        return {
          passed: false,
          evidence: `forbiddenUrgency=${forbiddenUrgency} pinsDollarFigure=${pinsDollarFigure}; reply="${reply}"`
        };
      }

      if (fixture.systemStage !== 'CAPITAL_QUALIFICATION') {
        return {
          passed: false,
          evidence: `systemStage=${fixture.systemStage}; expected CAPITAL_QUALIFICATION`
        };
      }

      return {
        passed: true,
        evidence: `decision=${decision.reason}; clarifier preserved CAPITAL_QUALIFICATION`
      };
    }
  }
}

// Re-export gate utilities used by fixtures so they can build minimal
// scenarios without importing voice-quality-gate directly.
export {
  detectMetadataLeak,
  acknowledgesEmotionally,
  isExplicitAcceptance,
  replyDeliversArtifact,
  containsCallPitch,
  containsCallOrBookingAdvancement,
  containsLogisticsQuestion,
  callLogisticsAlreadyDeliveredInRecentHistory
};
