/* eslint-disable no-console */
// Smoke-test scenarios. Each scenario seeds a specific conversation
// state, fires one trailing LEAD message at the real pipeline, and
// asserts on the persisted AI reply + Conversation state.
//
// Number alignment: SMOKE_NN matches the spec from the user task.
// SMOKE 07 runs the same payload 5× to catch intermittent metadata
// leaks — that's the only fan-out scenario.

import type { ReplyStateSnapshot, SmokeMessage } from './smoke-helpers';

const URL_REGEX = /\bhttps?:\/\/[^\s)>\]"']+/gi;

function urlsIn(text: string): string[] {
  return Array.from(text.matchAll(URL_REGEX)).map((m) =>
    m[0].replace(/[.,;:!?)\]]+$/, '')
  );
}

function ci(text: string, phrase: string): boolean {
  return new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(
    text
  );
}

function noneOf(
  text: string,
  phrases: string[]
): { ok: boolean; hits: string[] } {
  const hits = phrases.filter((p) => ci(text, p));
  return { ok: hits.length === 0, hits };
}

function someOf(text: string, phrases: string[]): boolean {
  return phrases.some((p) => ci(text, p));
}

export interface Scenario {
  id: string;
  name: string;
  history: SmokeMessage[];
  trailingLeadMessage: string;
  capturedDataPoints?: Record<string, unknown>;
  systemStage?: string | null;
  check: (
    snap: ReplyStateSnapshot,
    urls: TestUrls
  ) => { passed: true; evidence: string } | { passed: false; reason: string };
}

export interface TestUrls {
  downsell: string;
  applicationForm: string;
  fallbackContent: string;
}

// Re-imported here to avoid a circular import with smoke-config.
const TEST_URLS = {
  downsell: 'https://test.qualifydms.io/downsell',
  applicationForm: 'https://test.qualifydms.io/apply',
  fallbackContent: 'https://test.qualifydms.io/youtube'
};

const ROBOTIC_AUDIO_PHRASES = [
  "couldn't catch the audio",
  'type it out',
  'audio not supported',
  'cannot process audio'
];

const FABRICATED_STALL_PHRASES = [
  'give me a sec',
  'double-check',
  'point you wrong',
  'one moment',
  'hold on'
];

const URGENCY_RE_ASK_PHRASES = [
  'how soon',
  "what's your timeline",
  'when are you trying',
  'make this happen'
];

const SOFT_PITCH_PHRASES = [
  'call with anthony',
  'gameplan',
  'would you be open',
  'book a call'
];

export const SCENARIOS: Scenario[] = [
  {
    id: '01',
    name: 'voice-note-warm-fallback',
    history: [{ sender: 'AI', content: 'yo, what got you reaching out?' }],
    trailingLeadMessage: '[Voice note]',
    check: (snap) => {
      const r = noneOf(snap.reply, ROBOTIC_AUDIO_PHRASES);
      if (!r.ok)
        return {
          passed: false,
          reason: `robotic fallback hit: ${r.hits.join(', ')}`
        };
      const warm = someOf(snap.reply, [
        'something glitched',
        'glitched on my end',
        'audio',
        'voice'
      ]);
      return warm
        ? { passed: true, evidence: 'warm audio fallback present' }
        : {
            passed: false,
            reason: `no warm audio fallback in: "${snap.reply.slice(0, 160)}"`
          };
    }
  },

  {
    id: '02',
    name: 'capital-verified-stays-qualified',
    history: [
      { sender: 'AI', content: 'how much capital you working with?' },
      { sender: 'LEAD', content: 'around 7k bro' },
      {
        sender: 'AI',
        content:
          'cool. anthony does a free breakdown call — got availability monday at 3pm cst. that work?'
      }
    ],
    trailingLeadMessage: 'Yes that works for Monday',
    check: (snap) => {
      if (
        snap.systemStage === 'UNQUALIFIED' ||
        snap.outcome === 'UNQUALIFIED_REDIRECT'
      ) {
        return {
          passed: false,
          reason: `flipped to ${snap.systemStage}/${snap.outcome} despite verified capital`
        };
      }
      return {
        passed: true,
        evidence: `stage=${snap.systemStage} outcome=${snap.outcome}`
      };
    }
  },

  {
    id: '03',
    name: 'quiet-spot-no-repeat',
    history: [
      {
        sender: 'AI',
        content:
          "you're locked in for monday at 3pm cst. make sure you're in a quiet spot, headphones if you got em, and bring questions about your current setup."
      }
    ],
    trailingLeadMessage: 'Sounds good bro',
    check: (snap) => {
      const r = noneOf(snap.reply, [
        'quiet spot',
        'quiet area',
        'be prepared',
        'headphones'
      ]);
      if (!r.ok)
        return {
          passed: false,
          reason: `redundancy hit: ${r.hits.join(', ')}`
        };
      if (snap.reply.length > 120) {
        return {
          passed: false,
          reason: `reply too long (${snap.reply.length} chars), expected brief ack`
        };
      }
      return {
        passed: true,
        evidence: `brief ack (${snap.reply.length} chars), no redundancy`
      };
    }
  },

  {
    id: '04',
    name: 'binary-capital-yes-advances',
    history: [
      {
        sender: 'AI',
        content:
          'real quick — you sitting on at least $1000 set aside to start with?'
      }
    ],
    trailingLeadMessage: 'Yea I have',
    check: (snap) => {
      const r = noneOf(snap.reply, FABRICATED_STALL_PHRASES);
      if (!r.ok)
        return { passed: false, reason: `stall hit: ${r.hits.join(', ')}` };
      const captured = (
        snap.capturedDataPoints as Record<
          string,
          { value?: unknown } | undefined
        >
      ).capitalThresholdMet?.value;
      if (captured !== true) {
        return {
          passed: false,
          reason: `capitalThresholdMet=${JSON.stringify(captured)} (expected true)`
        };
      }
      return {
        passed: true,
        evidence: 'capitalThresholdMet=true, no stall, advanced'
      };
    }
  },

  {
    id: '05',
    name: 'artifact-delivered-with-url',
    history: [
      {
        sender: 'AI',
        content: 'self-paced course breaks down the system. want it?'
      }
    ],
    trailingLeadMessage: 'Yes bro',
    check: (snap, urls) => {
      if (!snap.reply.includes(urls.downsell)) {
        return {
          passed: false,
          reason: `downsell URL ${urls.downsell} missing from reply`
        };
      }
      const found = urlsIn(snap.reply);
      const off = found.filter((u) => !u.startsWith(urls.downsell));
      if (off.length > 0)
        return {
          passed: false,
          reason: `extra URLs present: ${off.join(', ')}`
        };
      return { passed: true, evidence: `downsell delivered, no extra URLs` };
    }
  },

  {
    id: '06',
    name: 'no-hallucinated-urls',
    history: [
      { sender: 'AI', content: 'how much capital you working with?' },
      { sender: 'LEAD', content: 'around $300' },
      {
        sender: 'AI',
        content:
          'got something for that range. self-paced course, anthony breaks down the system. want it?'
      }
    ],
    trailingLeadMessage: 'Yes I want that',
    check: (snap, urls) => {
      const allowed = [
        urls.downsell,
        urls.applicationForm,
        urls.fallbackContent
      ];
      const found = urlsIn(snap.reply);
      const unauthorized = found.filter(
        (u) => !allowed.some((a) => u.startsWith(a))
      );
      if (unauthorized.length > 0) {
        return {
          passed: false,
          reason: `unauthorized URLs: ${unauthorized.join(', ')}`
        };
      }
      return { passed: true, evidence: `urls=${found.join(', ')}` };
    }
  },

  // SMOKE 07 ×5 — different inputs, same metadata-leak gate.
  ...[
    'As soon as possible',
    'tryna replace my 9-5',
    'about 6 months bro',
    'i have around 2k',
    'kinda hesitant honestly'
  ].map(
    (input, idx): Scenario => ({
      id: `07-${idx + 1}`,
      name: `no-metadata-in-reply-${idx + 1}`,
      history: [
        { sender: 'AI', content: 'whats the goal you tryna hit?' },
        { sender: 'LEAD', content: 'replace my 9-5' },
        { sender: 'AI', content: 'love that. how soon?' }
      ],
      trailingLeadMessage: input,
      check: (snap) => {
        const patterns: RegExp[] = [
          /stage_confidence\s*[:=]/i,
          /quality_score\s*[:=]/i,
          /priority_score\s*[:=]/i,
          /\bintent\s*[:=]\s*[A-Z_]+/i,
          /\bstage\s*[:=]\s*[A-Z_]+/i,
          /\{[^}]*"[^"]+"\s*:\s*[^}]+\}/
        ];
        const hits = patterns.filter((p) => p.test(snap.reply));
        return hits.length === 0
          ? { passed: true, evidence: `no metadata leaks (input: "${input}")` }
          : {
              passed: false,
              reason: `metadata patterns matched: ${hits.map((p) => p.source).join('|')}`
            };
      }
    })
  ),

  {
    id: '08',
    name: 'religious-framing-not-unqualified',
    history: [
      { sender: 'AI', content: 'whats the goal you tryna hit by EOY?' },
      { sender: 'LEAD', content: 'replace my 9-5, take care of my mom' },
      { sender: 'AI', content: 'love that. how soon you tryna make it happen?' }
    ],
    trailingLeadMessage: "But I'm also trusting the lords timing",
    check: (snap) => {
      if (
        snap.systemStage === 'UNQUALIFIED' ||
        snap.systemStage === 'NOT_QUALIFIED'
      ) {
        return {
          passed: false,
          reason: `stage=${snap.systemStage} (premature)`
        };
      }
      if (snap.outcome === 'UNQUALIFIED_REDIRECT') {
        return { passed: false, reason: `outcome=${snap.outcome}` };
      }
      if (snap.reply.trim().length < 20) {
        return {
          passed: false,
          reason: `reply too short — ${snap.reply.length} chars`
        };
      }
      return {
        passed: true,
        evidence: `stage=${snap.systemStage}, outcome=${snap.outcome}, reply continues`
      };
    }
  },

  {
    id: '09',
    name: 'silent-stop-recovery-generates-response',
    history: [
      { sender: 'AI', content: 'you sitting on at least $1000 to start with?' }
    ],
    trailingLeadMessage: 'It could be',
    check: (snap) => {
      if (!snap.reply || snap.reply.trim().length === 0) {
        return { passed: false, reason: 'no AI reply generated — silent stop' };
      }
      return {
        passed: true,
        evidence: `reply generated (${snap.reply.length} chars)`
      };
    }
  },

  {
    id: '10',
    name: 'direct-question-acknowledged',
    history: [
      {
        sender: 'AI',
        content:
          'got something for you — self-paced course, anthony breaks down the system. want it?'
      }
    ],
    trailingLeadMessage: 'Yes of course. What does it include?',
    check: (snap) => {
      const acknowledgments = [
        'call',
        'anthony',
        'covers',
        'breaks down',
        'include',
        'content',
        'framework',
        'strategy',
        'playbook',
        'walks'
      ];
      if (!someOf(snap.reply, acknowledgments)) {
        return {
          passed: false,
          reason: `no question acknowledgment: "${snap.reply.slice(0, 160)}"`
        };
      }
      return { passed: true, evidence: 'question acknowledged' };
    }
  },

  {
    id: '11',
    name: 'burst-acknowledgment',
    history: [
      {
        sender: 'AI',
        content: "what's the biggest thing you keep wrestling with?"
      },
      { sender: 'LEAD', content: 'sick of the self flagellation haha' },
      { sender: 'LEAD', content: 'Rebuilding confidence man' }
    ],
    trailingLeadMessage:
      'Hows your relationship with these behavioural lapses in this stage of your trading?',
    check: (snap) => {
      const topicHit = someOf(snap.reply, [
        'confidence',
        'rebuild',
        'lapse',
        'flagellation',
        'punishing'
      ]);
      const emotionalAck = someOf(snap.reply, [
        'respect bro',
        'i hear you',
        'damn that takes guts',
        'real talk',
        'feel that',
        'been there'
      ]);
      return topicHit || emotionalAck
        ? {
            passed: true,
            evidence: `topicHit=${topicHit} emotionalAck=${emotionalAck}`
          }
        : {
            passed: false,
            reason: `no burst acknowledgment: "${snap.reply.slice(0, 160)}"`
          };
    }
  },

  {
    id: '12',
    name: 'below-threshold-routes-to-downsell',
    history: [
      { sender: 'AI', content: 'how much capital you got to start with?' }
    ],
    trailingLeadMessage:
      "Less than $1000, I'm tryna at least start with $1000 or more, I know it's not much",
    check: (snap, urls) => {
      const wrongRoute = noneOf(snap.reply, [
        'call with anthony',
        'gameplan',
        'book a call'
      ]);
      if (!wrongRoute.ok) {
        return {
          passed: false,
          reason: `wrong-route phrase hit: ${wrongRoute.hits.join(', ')}`
        };
      }
      if (snap.reply.includes(urls.applicationForm)) {
        return {
          passed: false,
          reason: `applicationForm URL leaked into below-threshold response`
        };
      }
      const okRoute =
        snap.reply.includes(urls.downsell) ||
        someOf(snap.reply, ['self-paced', 'course', 'bootcamp']);
      if (!okRoute) {
        return { passed: false, reason: `no downsell route signal in reply` };
      }
      const captured = (
        snap.capturedDataPoints as Record<
          string,
          { value?: unknown } | undefined
        >
      ).capitalThresholdMet?.value;
      if (captured === true) {
        return {
          passed: false,
          reason: `capitalThresholdMet=true (expected false)`
        };
      }
      return {
        passed: true,
        evidence: `routed to downsell, capitalThresholdMet=${JSON.stringify(captured)}`
      };
    }
  },

  {
    id: '13',
    name: 'capital-before-soft-pitch',
    history: [
      { sender: 'AI', content: 'whats the goal?' },
      { sender: 'LEAD', content: 'replace my 9-5, full time trading' },
      { sender: 'AI', content: 'how soon are you tryna make it happen?' }
    ],
    trailingLeadMessage: 'As soon as possible',
    check: (snap) => {
      const r = noneOf(snap.reply, SOFT_PITCH_PHRASES);
      if (!r.ok)
        return {
          passed: false,
          reason: `soft pitch fired pre-capital: ${r.hits.join(', ')}`
        };
      const capitalMentioned = someOf(snap.reply, [
        '$1000',
        '1000',
        'capital',
        'set aside',
        'ready to',
        'sitting on'
      ]);
      if (!capitalMentioned) {
        return {
          passed: false,
          reason: `did not bridge to capital question: "${snap.reply.slice(0, 160)}"`
        };
      }
      return { passed: true, evidence: 'advanced to capital, no soft pitch' };
    }
  },

  {
    id: '14',
    name: 'acceptance-delivers-artifact',
    history: [
      {
        sender: 'AI',
        content:
          'got a free youtube breakdown that covers the playbook — want me to send it?'
      }
    ],
    trailingLeadMessage: 'Yes of course bro',
    check: (snap, urls) => {
      if (!snap.reply.includes(urls.fallbackContent)) {
        return {
          passed: false,
          reason: `fallback content URL ${urls.fallbackContent} missing`
        };
      }
      const reAsk = someOf(snap.reply, [
        'how much capital',
        'sitting on',
        'at least $1000'
      ]);
      if (reAsk) {
        return {
          passed: false,
          reason: `re-asked qualification after acceptance`
        };
      }
      return { passed: true, evidence: 'acceptance honored, link delivered' };
    }
  },

  {
    id: '15',
    name: 'positive-disclosure-gets-response',
    history: [
      { sender: 'AI', content: 'where you at right now? paper or live?' }
    ],
    trailingLeadMessage:
      'Im already on a paper trade account so part 1 of the plan in progress',
    check: (snap) => {
      if (!snap.reply || snap.reply.trim().length === 0) {
        return { passed: false, reason: 'silent stop — no reply' };
      }
      const positive = someOf(snap.reply, [
        'respect',
        'love',
        'right move',
        'good move',
        "that's solid",
        'paper'
      ]);
      return positive
        ? { passed: true, evidence: 'positive ack present' }
        : {
            passed: false,
            reason: `no positive ack: "${snap.reply.slice(0, 160)}"`
          };
    }
  },

  {
    id: '16',
    name: 'no-repeat-urgency-question',
    history: [
      {
        sender: 'AI',
        content: 'how soon are you trying to turn that eval into a payout?'
      },
      { sender: 'LEAD', content: 'Like asap, if im optimistic' }
    ],
    trailingLeadMessage: 'i will try to make it happen till june',
    check: (snap) => {
      const r = noneOf(snap.reply, URGENCY_RE_ASK_PHRASES);
      return r.ok
        ? { passed: true, evidence: 'no urgency re-ask' }
        : { passed: false, reason: `urgency re-asked: ${r.hits.join(', ')}` };
    }
  },

  {
    id: '17',
    name: 'end-to-end-qualified-flow',
    history: [
      { sender: 'LEAD', content: 'Hi I saw your content' },
      {
        sender: 'AI',
        content:
          'yo appreciate you reaching out fr — you been trading already or just looking to start?'
      },
      { sender: 'LEAD', content: 'Been trading about a year' },
      { sender: 'AI', content: 'cool. whats the goal you tryna hit?' },
      { sender: 'LEAD', content: 'Want to hit $5k/month consistently' },
      {
        sender: 'AI',
        content: 'love that. how soon you tryna make it happen?'
      },
      { sender: 'LEAD', content: 'As soon as possible honestly' },
      {
        sender: 'AI',
        content: 'real quick — you sitting on at least $1000 ready to deploy?'
      },
      { sender: 'LEAD', content: 'I have about $3000 set aside' },
      {
        sender: 'AI',
        content:
          'perfect. wanna hop on a quick breakdown call so we can map out the next steps?'
      }
    ],
    trailingLeadMessage: '$3000',
    check: (snap, urls) => {
      const captured = (
        snap.capturedDataPoints as Record<
          string,
          { value?: unknown } | undefined
        >
      ).capitalThresholdMet?.value;
      if (captured !== true) {
        return {
          passed: false,
          reason: `capitalThresholdMet=${JSON.stringify(captured)} (expected true)`
        };
      }
      if (snap.reply.includes(urls.downsell)) {
        return {
          passed: false,
          reason: 'downsell URL leaked into qualified path'
        };
      }
      const found = urlsIn(snap.reply);
      const unauthorized = found.filter(
        (u) =>
          !u.startsWith(urls.applicationForm) &&
          !u.startsWith(urls.fallbackContent)
      );
      if (unauthorized.length > 0) {
        return {
          passed: false,
          reason: `unauthorized URLs: ${unauthorized.join(', ')}`
        };
      }
      const metadata = [
        /stage_confidence\s*[:=]/i,
        /quality_score\s*[:=]/i
      ].some((p) => p.test(snap.reply));
      if (metadata) return { passed: false, reason: 'metadata leak in reply' };
      return {
        passed: true,
        evidence: `capitalThresholdMet=true, urls=${found.join(', ') || 'none'}, stage=${snap.systemStage}`
      };
    }
  }
];

export { TEST_URLS };
