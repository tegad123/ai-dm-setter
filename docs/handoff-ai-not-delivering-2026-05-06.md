# Handoff — AI not delivering replies (silent send failure)

## TL;DR

The AI is generating replies and writing AI suggestions to the DB with
`wasSelected=true`, the scheduledReply is marked `status=SENT`, but no
`Message` row gets created and the lead never receives the DM.

Latest evidence: `_thehao` (conversationId
`cmosskp3g0003l4044aol4xew`). Two scheduledReply rows show
`status=SENT, lastError=null, processedAt=...` but `Message.findMany({
sender: 'AI' })` returns `[]`. Suggestion `cmotj5gui000bju04l7uzftrw`
has `wasSelected=true` and content "ahh damn bro, what's been the
biggest thing holding you back?" but it's nowhere in the messages
table.

A manual `sendDM` to the lead's `platformUserId` (`978166321264112` —
real numeric IGSID) returned **transient 500s from Meta** on all 3
retry attempts:
```
{ "error": { "message": "An unexpected error has occurred. Please retry your request later.",
              "type": "OAuthException", "is_transient": true, "code": 2 } }
```

So Meta's IG Send API is having an outage. Our pipeline's bug is that
**when the IG send fails, the error is swallowed in a try/catch — the
scheduledReply still gets `status=SENT` and `lastError` stays null**.
This makes outages look like AI silence and prevents any retry.

## What's already fixed (this session)

| Commit | Title |
|---|---|
| `27c6a1a` | `fix(manychat-handoff)`: resolve numeric IGSID handles before persisting lead |
| `8a3afdc` | `feat`: add MessageSource labeling (QUALIFYDMS_AI / MANYCHAT_FLOW / HUMAN_OVERRIDE / UNKNOWN) |
| `5718428` | `fix(ui)`: voice notes show real duration + drop bare placeholder text |
| `7dcf63b` | `fix(webhook-processor)`: recover lead profile from ManyChat when External Request was skipped |
| `dd04f7b` | `chore`: backfill autoSendOverride on legacy conversations (21 rows updated) |

The `autoSendOverride` backfill cleared the most common cause of "AI
toggle ON but no replies" — legacy conversations had `aiActive=true`
(schema default) with `autoSendOverride=false`, so the send-policy gate
`shouldAutoSendReply` returned false and the AI generated suggestions
that never auto-sent. After the backfill, gate returns true. AI engine
fires. **But the actual delivery still fails silently because of the
issue described above.**

## What still needs to be fixed

### 1. Silent failure in send pipeline (P0 — the active bug)

**Goal:** When IG send fails, propagate the error to the scheduledReply
row so (a) `lastError` is populated for debugging, (b) `status=FAILED`
is set instead of `SENT`, (c) the cron retries it on the next tick.

**Where to look:**

- Start with `processScheduledReply` in `src/lib/webhook-processor.ts`
  (around line 5906). Trace what marks the row `status=SENT`. The
  marker is being set BEFORE delivery is confirmed.
- The AI engine (`src/lib/ai-engine.ts`) calls into a send helper that
  invokes `sendDM` from `src/lib/instagram.ts`. Find the try/catch
  around `sendDM` — that's where the error is being swallowed. The
  scheduledReply row needs to know about the failure.
- `src/lib/instagram.ts:59` — `sendDM(accountId, recipientId, content)`.
  Already throws on non-2xx after 3 retries. Caller needs to surface
  the throw to the scheduledReply layer rather than catch+log.

**Acceptance criteria:**

- IG returns 500 → `ScheduledReply.status='FAILED'`,
  `lastError='<error message>'`, `attempts++`. Next cron tick retries
  if `attempts < N`.
- AI suggestion is created but `wasSelected=false` (or not selected
  until delivery confirms) so subsequent attempts don't dedup-skip.
- Add a Message row ONLY after `sendDM` returns a `messageId` — never
  optimistically.

**Existing patterns to mirror:**
- `processScheduledMessage` in
  `src/app/api/cron/process-scheduled-messages/route.ts` already has a
  `lastError` write-back pattern. Copy that shape.
- `scheduledReply.status` enum likely has `FAILED` already — verify in
  `prisma/schema.prisma`.

### 2. Inbound webhook numeric-handle guard (already spawned as a side task)

A side task was opened earlier in this session: "Add numeric-IGSID
handle guard to webhook processIncomingMessage". The
`processIncomingMessage` path at `src/lib/webhook-processor.ts:670-696`
already has a `getUserProfile` fallback when `senderHandle` is numeric,
but it relies on Meta's API which is exactly what's flaking right now.
The follow-up should add a ManyChat reverse-lookup as a secondary
fallback when `getUserProfile` itself fails.

### 3. ManyChat upfront External Request (operator-side, no code)

Daniel needs to add an Action block with an External Request **between
the trigger (`User follows your account`) and Send Message #4** in the
ManyChat flow editor. The existing Actions #1 only fires after button
click, capturing only ~1.6% of leads. The upfront block captures 100%.

Body for the new block (no `leadResponseText` since lead hasn't replied
yet):
```json
{
  "instagramUserId": "{{Username}}",
  "instagramUsername": "{{Username}}",
  "manyChatSubscriberId": "{{Contact Id}}",
  "openerMessage": "My man, thank you for the follow! 👊🏿  Always love to give value. Are you familiar with the Session Liquidity Model? If not, I can send it over.",
  "triggerType": "new_follower"
}
```

URL: `https://qualifydms.io/api/webhooks/manychat-handoff?key=qdm_mc_ca4a7454a8fa9b2253c1fec5cb8c640c`

Also enable "Retry on failure" in the External Request settings.

This is operator config, not code — but worth noting in the handoff so
the next session knows the context.

## Reference: how to reproduce + verify the silent-failure bug

```bash
# 1. Trigger an AI reply for a stuck conversation
pnpm exec tsx -e "
import prisma from './src/lib/prisma';
import { scheduleAIReply } from './src/lib/webhook-processor';
const lead = await prisma.lead.findFirst({ where: { handle: '_thehao' }, include: { conversation: { select: { id: true } } } });
await scheduleAIReply(lead.conversation.id, lead.accountId);
"

# 2. Wait ~60s, then check state
pnpm exec tsx -e "
import prisma from './src/lib/prisma';
const m = await prisma.message.findMany({ where: { conversationId: 'cmosskp3g0003l4044aol4xew', sender: 'AI' }, orderBy: { timestamp: 'desc' }, take: 3 });
const s = await prisma.scheduledReply.findMany({ where: { conversationId: 'cmosskp3g0003l4044aol4xew' }, orderBy: { createdAt: 'desc' }, take: 3 });
console.log('AI msgs:', JSON.stringify(m, null, 2));
console.log('Sched:', JSON.stringify(s, null, 2));
"
```

Expected after fix: when Meta is down, scheduledReply
`status=FAILED, lastError='IG send failed: 500 ...'`, no orphan Message
row, AISuggestion `wasSelected=false`.

Expected when Meta is up: `status=SENT, lastError=null`, Message row
with `platformMessageId`, AISuggestion `wasSelected=true`.

## Reference: known-stuck conversations

After backfill, 21 conversations have `aiActive=true,
autoSendOverride=true`. Some have a usable numeric `platformUserId`
and are unblocked once Meta recovers. Others have a username (like
`s.morton_`, `kracsumn`, `jessechimeez`, etc.) as `platformUserId` —
those wait for the lead's first inbound IG webhook to upgrade
`platformUserId` to the numeric IG ID.

The full list was logged during the backfill run at 2026-05-06 ~03:48
UTC. Re-run the backfill in DRY mode to see remaining stuck:
```bash
DRY_RUN=true pnpm exec tsx scripts/backfill-autosend-override.ts
```

## Repo state

- Branch: `main`
- Last commit: `dd04f7b` (backfill script)
- Working dir clean
- Auto-push enabled

## Skills useful for this fix

- `systematic-debugging` (root cause first, no symptom patches)
- `verification-before-completion` (run the reproduce script after the fix)
- `test-driven-development` if adding a regression test for the failure path

## Don't do

- Don't add try/catch swallows to "fix" the symptom — the goal is to
  surface failures, not hide them harder.
- Don't auto-retry inside the AI engine's send helper — let the
  scheduledReply cron own retry logic. Single source of truth.
- Don't modify the `manychat-handoff.ts` numeric guard — that's
  shipped and working. Focus on the send pipeline only.
