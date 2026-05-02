/* eslint-disable no-console */
// Static-shape tests for voice-note handling (FAILURE A + B,
// 2026-05-02). Greps the relevant source files to confirm:
//   1. Both webhook routes (instagram + facebook) accept audio
//      attachments through the inbound filter
//   2. Both webhook routes pass audioUrl into processAdminMessage
//      for echo / admin paths
//   3. processIncomingMessage extracts inboundAudioUrl + falls
//      back to "[Voice note]" when text is empty
//   4. processIncomingMessage persists isVoiceNote/voiceNoteUrl
//   5. processAdminMessage destructures audioUrl + persists
//      isVoiceNote/voiceNoteUrl on the HUMAN row
//   6. ai-engine prepends a <voice_note_received> directive when
//      lastLeadMsg.isVoiceNote === true
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '..');
const ig = readFileSync(
  resolve(root, 'src/app/api/webhooks/instagram/route.ts'),
  'utf-8'
);
const fb = readFileSync(
  resolve(root, 'src/app/api/webhooks/facebook/route.ts'),
  'utf-8'
);
const wp = readFileSync(resolve(root, 'src/lib/webhook-processor.ts'), 'utf-8');
const ai = readFileSync(resolve(root, 'src/lib/ai-engine.ts'), 'utf-8');

interface Check {
  label: string;
  pass: boolean;
}
const checks: Check[] = [];

checks.push({
  label: 'IG webhook: filter accepts audio attachments',
  pass: /!hasImageAttachment\(attachments\)\s*&&\s*!hasAudioAttachment\(attachments\)/.test(
    ig
  )
});
checks.push({
  label: 'IG webhook: admin path passes audioUrl to processAdminMessage',
  pass:
    /firstAudioAttachmentUrl\(attachments\)/.test(ig) &&
    /audioUrl:\s*audioUrl\s*\?\?\s*undefined/.test(ig)
});
checks.push({
  label: 'FB webhook: filter accepts audio attachments',
  pass: /!hasImageAttachment\(attachments\)\s*&&\s*!hasAudioAttachment\(attachments\)/.test(
    fb
  )
});
checks.push({
  label: 'FB webhook: admin path passes audioUrl to processAdminMessage',
  pass:
    /firstAudioAttachmentUrl\(attachments\)/.test(fb) &&
    /audioUrl:\s*audioUrl\s*\?\?\s*undefined/.test(fb)
});
checks.push({
  label: 'webhook-processor: extractFirstAudioUrl helper exists',
  pass: /function extractFirstAudioUrl\(/.test(wp)
});
checks.push({
  label:
    'webhook-processor: processIncomingMessage falls back to "[Voice note]"',
  pass: /\[Voice note\]/.test(wp) && /inboundAudioUrl/.test(wp)
});
checks.push({
  label:
    'webhook-processor: LEAD message create persists isVoiceNote/voiceNoteUrl',
  pass: /sender:\s*'LEAD'[\s\S]{0,400}isVoiceNote:\s*Boolean\(inboundAudioUrl\)[\s\S]{0,80}voiceNoteUrl:\s*inboundAudioUrl/.test(
    wp
  )
});
checks.push({
  label: 'webhook-processor: AdminMessageParams.audioUrl declared',
  pass: /AdminMessageParams[\s\S]{0,800}audioUrl\?:\s*string/.test(wp)
});
checks.push({
  label: 'webhook-processor: HUMAN echo persists isVoiceNote/voiceNoteUrl',
  pass: /humanSource:\s*'PHONE',[\s\S]{0,200}isVoiceNote:\s*Boolean\(audioUrl\)[\s\S]{0,80}voiceNoteUrl:\s*audioUrl\s*\?\?\s*null/.test(
    wp
  )
});
checks.push({
  label: 'ai-engine: voice_note_received directive prepended on isVoiceNote',
  pass: /lastLeadMsg\?\.isVoiceNote\s*===\s*true[\s\S]{0,300}<voice_note_received>/.test(
    ai
  )
});

let pass = 0;
let fail = 0;
for (const c of checks) {
  if (c.pass) {
    pass++;
    console.log(`PASS  ${c.label}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.label}`);
  }
}
console.log(
  `\n${pass}/${checks.length} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);
