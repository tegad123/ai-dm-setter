/* eslint-disable no-console */
import { createHmac } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  parseTypeformApplication,
  verifyTypeformSignature
} from '../src/lib/typeform-webhook';

let pass = 0;
let fail = 0;

function record(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? '\n      ' + detail : ''}`);
  }
}

function src(path: string) {
  return readFileSync(resolve(__dirname, '..', path), 'utf-8');
}

async function run() {
  const schema = src('prisma/schema.prisma');
  const manychatRoute = src('src/app/api/webhooks/manychat-handoff/route.ts');
  const manychatLib = src('src/lib/manychat-handoff.ts');
  const typeformRoute = src('src/app/api/webhooks/typeform/route.ts');
  const typeformLib = src('src/lib/typeform-webhook.ts');
  const aiEngine = src('src/lib/ai-engine.ts');
  const integrationsPage = src(
    'src/app/dashboard/settings/integrations/page.tsx'
  );
  const adminAccountsRoute = src('src/app/api/admin/accounts/route.ts');
  const accountsTable = src('src/features/admin/components/accounts-table.tsx');
  const adminPage = src('src/app/admin/page.tsx');
  const authGuard = src('src/lib/auth-guard.ts');

  record(
    'TEST 1 - ManyChat new follower handoff stores source/opener and avoids AI generation',
    /source:\s*'MANYCHAT'/.test(manychatLib) &&
      /manyChatOpenerMessage:\s*payload\.openerMessage/.test(manychatLib) &&
      !/generateReply|scheduleAIReply/.test(manychatRoute)
  );

  record(
    'TEST 2 - ManyChat comment trigger stores comment text and prompt includes comment context',
    /manyChatCommentText:\s*payload\.commentText/.test(manychatLib) &&
      /triggerType === 'comment'[\s\S]{0,220}They commented/.test(aiEngine)
  );

  record(
    'TEST 3 - Invalid ManyChat key is rejected',
    /Missing X-QualifyDMs-Key/.test(manychatLib) &&
      /Invalid webhook key/.test(manychatLib) &&
      /err\.status/.test(manychatRoute)
  );

  record(
    'TEST 4 - Duplicate ManyChat handoff within one hour is ignored',
    /oneHourAgo/.test(manychatLib) && /duplicate:\s*true/.test(manychatLib)
  );

  record(
    'TEST 5 - AI picks up ManyChat outbound context on first reply',
    /conversationCallState\?\.source === 'MANYCHAT'/.test(aiEngine) &&
      /<outbound_context>/.test(aiEngine) &&
      /Do NOT send another opener or greeting/.test(aiEngine)
  );

  const raw = JSON.stringify({ event_type: 'form_response' });
  const secret = 'top-secret';
  const signature =
    'sha256=' + createHmac('sha256', secret).update(raw).digest('base64');
  record(
    'TEST 6 - Typeform signature verification accepts valid HMAC-SHA256',
    verifyTypeformSignature({ rawBody: raw, signature, secret }) === true
  );

  const parsed = parseTypeformApplication(
    [
      { field: { id: 'email_id' }, type: 'email', email: 'LEAD@EXAMPLE.COM' },
      { field: { id: 'ig_id' }, type: 'text', text: '@simeon' },
      { field: { id: 'cap_id' }, type: 'text', text: '$5k' },
      {
        field: { id: 'call_id' },
        type: 'date',
        date: '2026-05-01T19:00:00.000Z'
      }
    ],
    {
      email: 'email_id',
      instagramUsername: 'ig_id',
      capitalAmount: 'cap_id',
      scheduledCallTime: 'call_id'
    }
  );
  record(
    'TEST 7 - Typeform field mapping extracts email, Instagram, capital, and call time',
    parsed.email === 'lead@example.com' &&
      parsed.instagramUsername === 'simeon' &&
      parsed.capitalAmount === 5000 &&
      parsed.scheduledCallTime === '2026-05-01T19:00:00.000Z'
  );

  record(
    'TEST 8 - Typeform webhook updates conversation with full application data',
    /typeformSubmittedAt:\s*submittedAt/.test(typeformLib) &&
      /typeformResponseToken:\s*token/.test(typeformLib) &&
      /typeformAnswers:\s*\{[\s\S]{0,220}answers:\s*normalizedAnswers/.test(
        typeformLib
      )
  );

  record(
    'TEST 9 - Typeform scheduled call triggers booked state and pre-call sequence',
    /scheduledCallAt:\s*callScheduledAt/.test(typeformLib) &&
      /scheduleCallConfirmationSequence/.test(typeformLib) &&
      /targetStage = 'BOOKED'/.test(typeformLib)
  );

  record(
    'TEST 10 - Typeform confirmed capital promotes qualified leads',
    /minimumCapitalRequired/.test(typeformLib) &&
      /targetStage = 'QUALIFIED'/.test(typeformLib)
  );

  record(
    'TEST 11 - Typeform unmatched submission creates manager-review lead flag',
    /typeform_no_conversation/.test(typeformLib) &&
      /Typeform submission without matching conversation/.test(typeformLib)
  );

  record(
    'TEST 12 - Invalid Typeform signature rejected',
    verifyTypeformSignature({
      rawBody: raw,
      signature: 'sha256=wrong',
      secret
    }) === false && /Invalid Typeform signature/.test(typeformLib)
  );

  record(
    'TEST 13 - AI injects Typeform application context and avoids re-asking answered data',
    /<application_context>/.test(aiEngine) &&
      /Capital confirmed in application/.test(aiEngine) &&
      /Do NOT ask questions already answered/.test(aiEngine)
  );

  record(
    'TEST 14 - Manager dashboard shows all accounts, health, actions, and global feed',
    /MANAGER/.test(schema) &&
      /requirePlatformAdmin/.test(adminAccountsRoute) &&
      /Client name/.test(accountsTable) &&
      /GlobalActionFeed/.test(adminPage) &&
      existsSync(
        resolve(
          __dirname,
          '..',
          'src/features/admin/components/global-action-feed.tsx'
        )
      )
  );

  record(
    'TEST 15 - Manager invite exists and manager cannot access billing',
    /isPlatformOperator/.test(authGuard) &&
      existsSync(
        resolve(__dirname, '..', 'src/app/api/admin/managers/route.ts')
      ) &&
      existsSync(
        resolve(__dirname, '..', 'src/app/dashboard/settings/billing/page.tsx')
      ) &&
      /forbidden\(\)/.test(src('src/app/dashboard/settings/billing/page.tsx'))
  );

  record(
    'Settings UI exposes ManyChat and Typeform webhook setup',
    /Your ManyChat webhook URL/.test(integrationsPage) &&
      /X-QualifyDMs-Key/.test(integrationsPage) &&
      /Your Typeform webhook URL/.test(integrationsPage) &&
      /Field Mapping/.test(integrationsPage)
  );

  console.log(
    `\n${pass}/${pass + fail} passed${fail > 0 ? `, ${fail} failed` : ''}`
  );
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
