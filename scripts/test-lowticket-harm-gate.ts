/**
 * Low-ticket harm predicate — the single source of truth reused at generation,
 * egress, and drip-send. Locks in the phrasings that MUST be blocked on a
 * low-ticket persona (including the ones the original gate regexes MISSED, found
 * in the 2026-07-23 full-pipeline research) and the safe copy that must NOT be
 * flagged.
 *
 * Run: npx tsx scripts/test-lowticket-harm-gate.ts
 */
import assert from 'node:assert/strict';
import {
  lowTicketHarmCategory,
  containsLowTicketHarm
} from '@/lib/voice-quality-gate';

// MUST be blocked. Includes the exact live-leaked line + the regex-miss set.
const HARMFUL: Array<[string, string]> = [
  // the exact message that shipped live (conv cmrp4fxl…)
  [
    'right now we don’t even know if you’re a good fit yet, not everyone has what it takes to be profitable. the call with Anthony is free though, we give you a gameplan and see if it makes sense from there.',
    'call_booking'
  ],
  ["let's set up a call", 'call_booking'],
  ['we can schedule a call', 'call_booking'],
  ["there's a free strategy session", 'call_booking'],
  ["i'll have my closer reach out", 'call_booking'],
  ['Anthony can walk you through it on a call', 'call_booking'],
  ['you free for a call this week?', 'call_booking'],
  ['just click the calendly link', 'call_booking'],
  ['wanna hop on a quick call?', 'call_booking'],
  ['get on a quick call with anthony', 'call_booking'],
  ['the call is with your coach', 'call_booking'],
  // capital / financial screening
  ['how much you working with', 'capital'],
  ['you got any money to start with?', 'capital'],
  ['can you afford $1k?', 'capital'],
  ['do you have enough to get going?', 'capital'],
  ['what kind of budget are we talking', 'capital'],
  ['you got some cash to put in?', 'capital'],
  ["what's your capital situation like right now?", 'capital'],
  // scheduling / timezone
  ['what day works for you?', 'scheduling'],
  ['what timezone are you in?', 'scheduling'],
  ['when are you free?', 'scheduling'],
  ["what's your availability like?", 'scheduling']
];

// MUST NOT be flagged — legitimate low-ticket funnel copy (website-link asset).
const SAFE: string[] = [
  'for sure bro, everything you need to get started is on the page i mentioned, take a look and lmk what stands out',
  'so are you new in the markets or have you been trading for a while?',
  'nah i hear that, what would getting better actually look like for you?',
  'that makes sense bro, what have you been struggling with the most?',
  'good q bro',
  'respect for reaching out, let me see if i can help',
  'the page breaks down the whole system, check it out',
  'what stood out to you from the video?',
  'how long you been trading?',
  'appreciate you being real about that'
];

let ok = 0;
let bad = 0;
for (const [text, expectedCat] of HARMFUL) {
  const cat = lowTicketHarmCategory(text);
  const pass = cat !== null; // any harm category is a correct block
  if (pass) ok++;
  else {
    bad++;
    console.log(`BAD (should block) got=${cat} :: ${text.slice(0, 60)}`);
  }
  // category is advisory; we only hard-require SOME category. Note mismatches.
  if (cat && cat !== expectedCat) {
    console.log(
      `  note: "${text.slice(0, 40)}" blocked as ${cat} (expected ${expectedCat}) — still blocked, ok`
    );
  }
}
for (const text of SAFE) {
  const flagged = containsLowTicketHarm(text);
  if (!flagged) ok++;
  else {
    bad++;
    console.log(
      `BAD (should be safe) flagged=${lowTicketHarmCategory(text)} :: ${text.slice(0, 60)}`
    );
  }
}

assert.equal(bad, 0, `${bad} low-ticket harm gate case(s) failed`);
console.log(
  `low-ticket harm gate: ${ok}/${HARMFUL.length + SAFE.length} passed (${HARMFUL.length} harmful blocked, ${SAFE.length} safe allowed)`
);
