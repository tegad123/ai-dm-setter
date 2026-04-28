/* eslint-disable no-console */
// Pure-logic test for the multi-bubble fix. Tests:
//   1. Parser auto-split on \n+ (single newlines)
//   2. splitConcatenatedAckQuestion no-newline split
//   3. looksLikeConcatenatedAckQuestion detection in voice gate
import { looksLikeConcatenatedAckQuestion } from '../src/lib/voice-quality-gate';

interface SplitCase {
  label: string;
  input: string;
  expectBubbles: number;
}

// Simulates the auto-split chain from parseAIResponse: try \n+ first,
// fall back to splitConcatenatedAckQuestion. Mirror exactly so the
// test catches regressions in either path.
function autoSplit(s: string): string[] {
  const parts = s
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  if (parts.length >= 2) return parts.slice(0, 4);
  // Fallback: ack+question concatenation
  const ACK_OPENER_RE =
    /^(that'?s|gotchu|gotcha|love that|fasho|damn|bet|sick|respect|facts?|fire|yo|yeah|appreciate|ah|aight|word|nice|solid|dope|aw|oh|hey|hell yeah|hella|big bro|bro)\b/i;
  const trimmed = s.trim();
  if (!trimmed.endsWith('?') || !ACK_OPENER_RE.test(trimmed)) return [trimmed];
  const m = /^(.+[.!])\s+([^.!?]*\?)$/.exec(trimmed);
  if (!m) return [trimmed];
  return [m[1].trim(), m[2].trim()];
}

const splitCases: SplitCase[] = [
  // Daetradez-style: single-newline-separated thoughts
  {
    label: 'single newline split',
    input:
      'yo appreciate you reaching out bro\nare you new in the markets or you been trading for a while?',
    expectBubbles: 2
  },
  {
    label: 'multiple single-newlines',
    input:
      "ah damn bro, i hear you\n30% a month on a 10k account is a serious target too\nwhat's been the main thing tripping you up?",
    expectBubbles: 3
  },
  // Legacy double-newline still works
  {
    label: 'double newline (legacy)',
    input:
      "damn bro, that's a real grind\n\ngotchu though, if you got 2k set aside you're in a decent spot\n\nhow soon are you tryna make the jump?",
    expectBubbles: 3
  },
  // No-newline concatenation
  {
    label: 'no-newline ack+question split',
    input: "damn bro, that's a real grind. how long you been at it?",
    expectBubbles: 2
  },
  {
    label: 'gotchu ack + question with period',
    input:
      "gotchu bro, that's a solid spot. what's the main thing you're tryna fix?",
    expectBubbles: 2
  },
  // Single-thought stays as one bubble
  {
    label: 'single thought stays one',
    input:
      "real quick, what's your capital situation like for the markets right now?",
    expectBubbles: 1
  },
  {
    label: 'short ack stays one',
    input: 'bet bro, how long you been trading for?',
    expectBubbles: 1 // too short / no sentence boundary in middle
  },
  // Edge: legitimate prose with comma should NOT split via parser
  {
    label: 'legitimate single sentence ending in question',
    input: 'how soon are you tryna make the jump?',
    expectBubbles: 1
  }
];

let pass = 0;
let fail = 0;
for (const c of splitCases) {
  const out = autoSplit(c.input);
  const ok = out.length === c.expectBubbles;
  if (ok) {
    pass++;
    console.log(`PASS  split: ${c.label} → ${out.length} bubble(s)`);
  } else {
    fail++;
    console.log(
      `FAIL  split: ${c.label} → ${out.length} bubble(s), expected ${c.expectBubbles}\n      out: ${JSON.stringify(out)}`
    );
  }
}

interface GateCase {
  label: string;
  input: string;
  expectFlag: boolean;
}

const gateCases: GateCase[] = [
  {
    label: 'concatenated ack+question fires',
    input: "damn bro that's a real grind, how long you been at it?",
    expectFlag: true
  },
  {
    label: 'ack with period+question fires',
    input:
      "gotchu bro, that's a solid spot. what's the main thing you're tryna fix?",
    expectFlag: true
  },
  {
    label: 'single short question OK',
    input: 'how long you been trading for?',
    expectFlag: false
  },
  {
    label: 'pure statement OK',
    input: "that's solid bro, you're already way ahead of most people.",
    expectFlag: false
  },
  {
    label:
      'short bet+question STILL flagged (rule: ack and question never in same bubble)',
    input: 'bet bro, how long you been trading for?',
    expectFlag: true
  }
];

for (const c of gateCases) {
  const flagged = looksLikeConcatenatedAckQuestion(c.input);
  const ok = flagged === c.expectFlag;
  if (ok) {
    pass++;
    console.log(`PASS  gate: ${c.label} → flagged=${flagged}`);
  } else {
    fail++;
    console.log(
      `FAIL  gate: ${c.label} → flagged=${flagged}, expected ${c.expectFlag}`
    );
  }
}

console.log(
  `\n${pass}/${splitCases.length + gateCases.length} passed${
    fail > 0 ? `, ${fail} failed` : ''
  }`
);
if (fail > 0) process.exit(1);
