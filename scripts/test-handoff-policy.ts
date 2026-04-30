/* eslint-disable no-console */
// Static audit of the handoff-trigger / email-wiring change
// (2026-04-30). Greps the relevant source files to verify:
//
// CHANGE 1 — softened gates
//   • ai-engine.ts no longer sets escalateToHuman=true at the
//     #14/#15/#16 retry-loop branches (unnecessary scheduling Q,
//     logistics-before-qualification, repeated-question)
//   • ai-engine.ts splits the unshippable list — markdown +
//     repeated_capital_question route through soft-fail audit;
//     bracketed_placeholder + link_promise + call_pitch_before_capital
//     stay in the hard-escalate branch
//   • webhook-processor.ts ship-time markdown guard no longer
//     pauses or notifies — falls through to ship best-effort
//
// CHANGE 2 — email wiring
//   • All CRITICAL hard-pause triggers call escalate() (which
//     dispatches both in-app + URGENT email when the per-type
//     notify flag is on)
//   • No CRITICAL trigger uses raw prisma.notification.create
//
// Pure-static check — no DB writes. Reads files from disk.
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '..');
const aiEngine = readFileSync(resolve(root, 'src/lib/ai-engine.ts'), 'utf-8');
const webhook = readFileSync(
  resolve(root, 'src/lib/webhook-processor.ts'),
  'utf-8'
);
const callConfirm = readFileSync(
  resolve(root, 'src/lib/call-confirmation-sequence.ts'),
  'utf-8'
);

interface Check {
  label: string;
  pass: boolean;
  detail?: string;
}

const checks: Check[] = [];

// ── Change 1 — soft-fail audit row pattern present ──────────────
checks.push({
  label: 'ai-engine: #14/15/16 soft-fail block present (gate=scheduling_q)',
  pass:
    aiEngine.includes('gateType = unnecessarySchedulingQuestionFailed') &&
    aiEngine.includes("'gate_exhausted_sent_best_effort'") &&
    aiEngine.includes('`gate=${gateType}')
});

checks.push({
  label: 'ai-engine: #14/15/16 no longer set escalateToHuman=true',
  pass: !/(unnecessarySchedulingQuestionFailed[\s\S]{0,200}escalateToHuman\s*=\s*true)/.test(
    aiEngine
  )
});

// Split #18 — markdown + repeated_capital_question removed from hardUnshippable
checks.push({
  label:
    'ai-engine: hardUnshippable kept = bracketed_placeholder + link_promise + call_pitch_before_capital',
  pass: /hardUnshippable[\s\S]{0,400}bracketed_placeholder_leaked:[\s\S]{0,200}link_promise_without_url:[\s\S]{0,200}call_pitch_before_capital_verification:/.test(
    aiEngine
  )
});

checks.push({
  label:
    'ai-engine: softUnshippable defined = markdown + repeated_capital_question',
  pass: /softUnshippable[\s\S]{0,200}markdown_in_single_bubble:[\s\S]{0,200}repeated_capital_question:/.test(
    aiEngine
  )
});

// markdown_at_ship in webhook-processor is now soft (writes audit, no pause/notif)
checks.push({
  label:
    'webhook-processor: ship-time markdown writes audit row, no aiActive=false in same block',
  pass:
    webhook.includes('gate=markdown_at_ship') &&
    !/markdown_in_single_bubble_at_ship[\s\S]{0,500}aiActive:\s*false/.test(
      webhook
    )
});

// ── Change 2 — escalate() wired at the previously notif-only sites ──
checks.push({
  label: "webhook-processor: distress L1 calls escalate({ type: 'distress' })",
  pass: /DISTRESS DETECTED[\s\S]{0,3000}escalate\(\{[\s\S]{0,200}type:\s*'distress'/.test(
    webhook
  )
});

checks.push({
  label:
    "webhook-processor: distress L2 (sendAIReply) calls escalate({ type: 'distress' })",
  pass: /Layer 2 distress[\s\S]{0,3000}escalate\(\{[\s\S]{0,200}type:\s*'distress'/.test(
    webhook
  )
});

checks.push({
  label:
    "webhook-processor: empty-output ship-time uses escalate({ type: 'ai_stuck' })",
  pass: /empty_message_blocked[\s\S]{0,1200}escalate\(\{[\s\S]{0,200}type:\s*'ai_stuck'/.test(
    webhook
  )
});

checks.push({
  label:
    "webhook-processor: R24 ship-time block uses escalate({ type: 'ai_stuck' })",
  pass: /r24_failed_call_pitch_at_ship[\s\S]{0,1200}escalate\(\{[\s\S]{0,200}type:\s*'ai_stuck'/.test(
    webhook
  )
});

checks.push({
  label:
    "webhook-processor: bracketed-placeholder ship-time uses escalate({ type: 'ai_stuck' })",
  pass: /bracketed_placeholder_at_ship[\s\S]{0,1200}escalate\(\{[\s\S]{0,200}type:\s*'ai_stuck'/.test(
    webhook
  )
});

checks.push({
  label:
    "webhook-processor: link-promise ship-time uses escalate({ type: 'ai_stuck' })",
  pass: /link_promise_without_url_at_ship[\s\S]{0,1200}escalate\(\{[\s\S]{0,200}type:\s*'ai_stuck'/.test(
    webhook
  )
});

checks.push({
  label:
    "webhook-processor: R20 generic escalate uses escalate({ type: 'ai_stuck' })",
  pass: /if\s*\(result\.escalateToHuman\)[\s\S]{0,3000}escalate\(\{[\s\S]{0,400}type:\s*'ai_stuck'/.test(
    webhook
  )
});

checks.push({
  label:
    "call-confirmation: reschedule calls escalate({ type: 'scheduling_conflict' })",
  pass: /handleCallRescheduleNeeded[\s\S]{0,1500}escalate\(\{[\s\S]{0,200}type:\s*'scheduling_conflict'/.test(
    callConfirm
  )
});

// Negative checks — make sure the OLD raw notification.create paths
// were actually replaced in the distress / ship-time blocks (no
// stale duplicate writes).
const distressL1RawNotif =
  /DISTRESS DETECTED[\s\S]{0,3000}prisma\.notification\.create\(\{[\s\S]{0,400}type:\s*'SYSTEM',[\s\S]{0,400}distress signal detected/.test(
    webhook
  );
checks.push({
  label:
    'webhook-processor: distress L1 no longer uses raw prisma.notification.create',
  pass: !distressL1RawNotif
});

let pass = 0;
let fail = 0;
for (const c of checks) {
  if (c.pass) {
    pass++;
    console.log(`PASS  ${c.label}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.label}${c.detail ? '\n      ' + c.detail : ''}`);
  }
}

console.log(
  `\n${pass}/${checks.length} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);
