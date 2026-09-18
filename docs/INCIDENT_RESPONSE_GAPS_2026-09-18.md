# Convlo response-gap incident record

## Purpose

This document records every confirmed reason currently known for a lead to look
unanswered in Convlo. It separates live defects, historical failures, intentional
holds, and unverified hypotheses so that development and operations do not treat
them as one outage.

Evidence was collected on 2026-09-18 from production in read-only database
transactions, the Convlo dashboard, the authenticated `@daetradez` Instagram
inbox, and the ManyChat workspace. No production rows were changed or replayed
during the audit.

## Current production baseline

- Runtime version currently reported by `/api/version`:
  `b11a213538d9c6ee1769d4bf9c2daa6fd6963156`. It was read directly from
  production at 2026-09-18 19:12 UTC.
- Production code baseline for the ManyChat delivery-truth release:
  `c962f780e7e4b3dd85391e0fa6bdeeaf81fe1c2c`.
- PR #50, the ManyChat delivery-truth and callback-parity release, merged at
  2026-09-18 18:26:58 UTC and deployed successfully by Vercel.
- The production dashboard completed a fresh authenticated reload after the
  deployment and returned current Instagram and Facebook conversation data.
  This confirms the additive message-delivery migration is active and the
  deployed application can read it.
- The deployment also includes PR #49, the durable queued ManyChat first-reply
  intake and worker.
- Receipt migration `20260918170000_manychat_handoff_receipts` completed at
  2026-09-18 17:02:19 UTC.
- Delivery-evidence migration `20260918193000_message_delivery_evidence`
  completed between 2026-09-18 18:27:15 and 18:27:17 UTC.
- Daniel's account currently has Instagram and Facebook Away Mode enabled,
  generate-only disabled on both channels, default AI enabled, response delay
  45-120 seconds, and debounce 3 seconds.
- Queued first-reply mode is enabled only in the controlled test-tagged ManyChat
  callback. It has not been enabled for general new-follower traffic.

## Executive finding

There is no single cause for all unanswered messages. The confirmed classes are:

1. Convlo historically displayed planned ManyChat opener context as a sent
   message even when Instagram had no message. PR #50 corrected the display and
   AI-history behavior for current production.
2. The ManyChat first-reply callback cannot run when the lead never receives the
   opener and therefore never answers.
3. Historical Instagram sends failed because Convlo was not the Meta thread
   owner. Those failures have stopped appearing in new jobs, but old
   conversations remain unrecovered.
4. Some messages were ingested and generated correctly, then suppressed by
   script routing or quality rules.
5. Distress and human-review holds intentionally prevent automatic delivery.
6. Some individual conversations have AI disabled.
7. Some reply jobs failed without producing a delivered outbound message.
8. Facebook ManyChat message and completion callbacks historically contained
   Instagram-only lookup logic. PR #50 corrected that path, but no live
   Facebook callback proof exists yet.
9. Instagram standby events are visible to Convlo's audit logger but are not
   safe to process as normal lead messages until ownership is proven.
10. Historical planned ManyChat opener rows previously entered AI history and
    raw database counts even when the dashboard did not render them as sent.
    PR #50 now excludes them while preserving the audit rows.
11. The live ManyChat new-follower flow does not add the tag required by the
    live Instagram Default Reply flow. A normal first reply therefore takes the
    false branch and never invokes Convlo's queued first-reply callback.
12. The queued first-reply path has never completed a production intake. There
    are currently zero `ManyChatHandoffReceipt` rows in production, so the code
    is deployed but has no live success proof.
13. The connected Facebook Page was not subscribed to `message_echoes`. The
    subscription and reconnect code are corrected, but a real outbound echo is
    still required as end-to-end proof.
14. ManyChat conversations whose first reply arrived more than two hours after
    the opener were reclassified as warm direct inbound. The routing correction
    is deployed, but a delayed production conversation has not yet proved it.
15. Facebook queued first-reply receipt intake is still Instagram-only, even
    though the message and completion callbacks are now platform-aware.
16. The Facebook inline webhook could reset terminal quality exceptions to
    pending, and the cron could preserve a failed quality job after a confirmed
    delivery. The reconciliation correction is deployed; historical
    contradictory rows remain unrecovered.

## Immediate incident ledger at 2026-09-18 19:12 UTC

This is the current operational state. It distinguishes what is live, what is
only prepared in code, and what still lacks production proof.

### Live and verified

- PR #49 and PR #50 are deployed. Planned ManyChat opener context is no longer
  shown as a delivered message, and the durable receipt/worker code exists.
- Production reports application commit
  `b11a213538d9c6ee1769d4bf9c2daa6fd6963156`. GitHub reports the Vercel
  deployment succeeded.
- The connected Facebook Page subscription now includes both `messages` and
  `message_echoes`. Graph API readback verified the expected field set after the
  repair at approximately 2026-09-18 18:54 UTC.
- The live ManyChat `Say hi to new followers` flow is back in its pre-test state:
  context-only external request, then the Instagram Opening DM. The temporary
  `Convlo - Awaiting first reply` tag action was removed by restoring the last
  verified pre-test version. A fresh reload confirmed the live Actions node has
  only the external request and remains connected to the Opening DM.
- There have been no new Meta `2534037` thread-owner failures after
  2026-09-17 20:00 UTC. This does not recover the 59 historical failures.

### Deployed, awaiting conversation-level production proof

- Delayed ManyChat first-reply routing:
  `cb24650c877b6e69793a3c8f7df44e69dfb035f8`. It replaces the two-hour age
  heuristic with durable first-turn evidence and passed focused tests,
  TypeScript, Prisma validation, and the production build.
- Facebook terminal-quality reconciliation:
  `c5b4893f26594e09a06dcd3761e056d2d9d765d7`. It prevents terminal exceptions
  from returning to `PENDING` and reconciles a causally relevant delivered Meta
  message before recording failure. Focused tests, TypeScript, Prisma checks,
  and the production build passed.
- Meta subscription-health correction:
  `17dd6f1d7d879e72008751fe4981d324ea524562`. It centralizes expected Page
  fields, prevents a direct Instagram reconnect from dropping
  `message_echoes`, and makes alerts state the actual missing field. Its focused
  tests, TypeScript, Prisma checks, and production build passed.
- The combined deployment passed 90 targeted tests, TypeScript, Prisma
  validation, schema lint, and the production build before push. Production
  `/api/version` then reported `b11a213` after Vercel marked the deployment
  successful.

### Still open

- Production has zero `ManyChatHandoffReceipt` rows. The queued first-reply path
  has never completed a real production intake.
- The Instagram Default Reply still requires the exact test tag. The general
  new-follower flow deliberately does not add it until the controlled proof
  passes. For a controlled test, the tag must be added only to the authorized
  test contact after the opener is visible in both Instagram inboxes.
- The special Follow-to-DM opener has no ordinary post-send callback. The early
  callback proves intent and context, not delivery. A native Meta echo or the
  authoritative Instagram thread must prove the opener.
- One real Facebook Page, phone, or ManyChat outbound must produce a
  `message_echoes` event in Convlo before the subscription repair is closed.
- Facebook durable `queued_first_reply` intake still rejects non-Instagram
  receipts. Platform-aware message and completion callbacks do not close this
  gap.
- The delayed ManyChat and Facebook terminal-state corrections need
  conversation-level production proof.
- Historical ownership failures, Rob's suppressed turn, Rade's stranded event,
  and existing terminal failures remain preserved and unreplayed.
- Distress, human-review, AI-off, and terminal quality cases will remain silent
  until an operator explicitly resolves or closes them. They are not general
  webhook failures.

## Current status at a glance

| Area | Current status | What remains |
| --- | --- | --- |
| ManyChat opener truth | Code correction deployed | Fresh opener and native Meta echo proof |
| Instagram first-reply intake | Durable worker deployed | Fix or manually satisfy the ManyChat tag gate, then run a fresh test |
| ManyChat new-follower automation | Pre-test flow restored; no general tag rollout | Add the tag only to an authorized test contact, then require a fresh proof before rollout |
| Facebook callback parity | Code correction deployed | Fresh Facebook callback, one job, Meta message ID, and continuation proof |
| Facebook outbound echoes | `message_echoes` restored at 2026-09-18 18:54 UTC | Verify one phone/ManyChat echo enters Convlo |
| Delayed ManyChat first replies | Code correction deployed | Prove delayed first-reply routing with no duplicate |
| Facebook queued first reply | Intake remains Instagram-only | Extend receipt identity handling and obtain a real Facebook receipt proof |
| Facebook terminal-quality state | Code correction deployed | Prove a delivered reply cannot remain terminally failed |
| Meta thread ownership | No new `2534037` after 2026-09-17 20:00 UTC | Identify or document routing owner and separately review 59 stranded failures |
| Script suppression | Guard deployed | Rob's historical turn remains unrecovered |
| Safety and review holds | Working as designed | Monitored operator queue and explicit respond, resume, or close action |
| Historical failures | Preserved, not replayed | Dry-run eligibility list and separate approval before any replay |
| Post-deploy Instagram traffic | No Daniel events since PR #50 deployment | A fresh authorized test is still required |

## Issue 1: phantom ManyChat opener bubbles

**Status:** Confirmed historical defect. The code correction is deployed in
PR #50. The incident remains open until the fresh controlled Instagram proof
passes.

Before PR #50, Convlo stored the opener supplied by an early ManyChat context
callback as a normal outbound `Message`. The message had no Meta message ID and
no delivery status, but the dashboard rendered it as a purple
`ManyChat · flow` sent bubble, incremented the message count, and used it in the
conversation-list preview.

The callback proves that ManyChat intended to run a flow. It does not prove that
ManyChat sent the opener or that Meta accepted it.

### Squirrel production proof

- Handle: `@squirrel.8425393`
- Lead: `cmu77pjja0001lb04ycrhqrg2`
- Conversation: `cmu77pjjb0003lb04vrwwnh26`
- ManyChat subscriber: `2078481927`
- Stored opener row: `cmu77pjqi0005lb04s3di3sz5`
- Created at approximately 2026-09-18 17:08 UTC
- `platformMessageId`: null
- Durable first-reply receipt: none
- Scheduled reply: none
- Generation trace: none
- Egress event: none

Convlo showed the opener as sent. The real Instagram thread was empty on both
sides. ManyChat showed the new-follower automation trigger but no opener message
record, and the contact was inactive.

The same comparison on `@xo8nx` showed an empty Instagram thread while Convlo
displayed an outbound ManyChat opener.

### Scope evidence

For 66 Instagram new-follower conversations created since September 17:

- all 66 contain planned opener rows;
- only one conversation contains any ManyChat outbound with a Meta message ID;
- only two contain native lead responses;
- 64 contain only the planned opener and no native lead response.

This does not prove all 64 openers failed. It proves Convlo cannot distinguish
delivered, failed, and merely planned openers. Squirrel and xo8nx are the two
externally verified false sent-looking examples.

### Original code cause

- `src/lib/manychat-handoff.ts` creates the opener `Message` during the context
  callback.
- `src/lib/manychat-message.ts` records a provider callback without proving Meta
  delivery and can place a ManyChat ID into a field documented as a Meta ID.
- `src/lib/manychat-handoff-worker.ts` can manufacture a missing opener row while
  processing a receipt.
- The conversation API and dashboard do not carry or render a truthful delivery
  state for ManyChat messages.

### Required correction

- Store pre-send opener text as conversation context, not delivered history.
- If a flow exposes a post-send action, run `/manychat-message` only after the
  actual ManyChat send step. The published Follow-to-DM graph currently does not
  expose an ordinary immediate next step after its special opener, so this
  callback cannot be required for that opener.
- Store ManyChat's provider operation ID separately from Meta's message ID.
- Represent `planned`, `provider reported`, `Meta confirmed`, and `failed`
  separately in the database and UI.
- Do not let the queued worker invent an opener message. It may use the saved
  opener text as hidden AI context, and a valid first lead response must still be
  processed even when no provider-reported opener row exists.
- Reconcile a later native Meta echo to the provider-reported row without making
  a duplicate bubble.

### Confirmed live ManyChat graph constraint

The published `Say hi to new followers` graph runs:

1. follow trigger;
2. Actions node containing the Convlo handoff request;
3. special Instagram Opening DM node.

The Actions node reported 67 unique contacts. The reused Send Message node showed
large aggregate historical metrics and 100% delivery, but the UI did not provide
a per-contact Meta message ID tying Squirrel to a delivery. Those aggregate
metrics therefore do not override the empty authoritative Instagram thread.

For this flow, the safe behavior is to keep the pre-send callback as metadata
only. If Meta later sends a native echo, Convlo can show a confirmed opener. If
the lead replies or clicks the opener, Convlo can process that real inbound and
continue AI even while the opener itself remains unrendered or unverified.

## Issue 2: durable first-reply intake cannot start before a real opener

**Status:** PR #49 is deployed and healthy, but production success is unproven
because the Squirrel test never reached this path.

The new `queued_first_reply` mode solves the earlier HTTP timeout by persisting a
receipt before background work. It does not send the ManyChat opener. Squirrel
had no lead answer and therefore created no `ManyChatHandoffReceipt`.

The remaining production proof must show:

1. a real opener in Instagram;
2. one native lead answer;
3. one durable receipt;
4. one scheduled reply;
5. one delivered AI response with a Meta message ID;
6. normal script continuation;
7. no duplicate when native Meta and ManyChat callbacks arrive concurrently.

## Issue 3: historical Meta thread-owner failures

**Status:** Confirmed historical incident. No new occurrence after the timestamp
below, but the old failures remain stranded.

- Exactly 59 Instagram ScheduledReply failures contained Meta subcode `2534037`.
- First observed: 2026-09-15 21:17:59 UTC.
- Last observed: 2026-09-17 19:50:58 UTC.
- Since 2026-09-17 20:00 UTC, production recorded 55 sent Instagram jobs and zero
  additional `2534037` jobs.

Example:

- Handle: `@forged.by.faithh`
- Conversation: `cmu42ger30017jq04md2hvri5`
- Scheduled reply: `cmu42gnjr001ajq04mljk4qyh`
- Meta error: code `100`, subcode `2534037`, Convlo was not thread owner
- Five attempts failed; later recovery encountered the same ownership error.

The ownership audit has 69 records: 42 `standby_message` and 27 `standby_event`.
It has no `pass_thread_control`, `take_thread_control`,
`request_thread_control`, or `messaging_handover` event, and no previous/new
owner app IDs. The logs prove standby traffic existed, but they cannot identify
the other owner or prove how ownership later changed.

### Operational consequence

The absence of new ownership errors is encouraging, but it does not recover the
59 old failures. They need a separately reviewed eligibility list before any
replay. Do not replay them in bulk.

## Issue 4: generated answer suppressed by routing

**Status:** Confirmed historical failure; the affected turn is unrecovered.

For `@rob.vacco`, Convlo generated the answer `nah fr bro, this side is futures
focused`, then the router selected Step 7's `No response` branch. The runtime
guard suppressed the generated answer. No egress row or AI `Message` was created,
and the reply job failed as completed without delivery.

This is an internal router/suppression failure, not a Meta delivery problem. A
guard for the impossible `No response` selection on a newest lead message was
deployed earlier, but Rob's old turn was not replayed.

## Issue 5: intentional distress and human-review holds

**Status:** Expected safety behavior; operations gap remains.

For `@rajujoshua6`, Convlo generated a supportive draft, but the egress gate set
`HELD_DISTRESS`. The conversation remains in human review with
`distressDetected=true`, `awaitingHumanReview=true`, and
`awaitingAiResponse=true`. No automatic message should be sent until a human
handles the review.

The practical problem is that held conversations need a monitored operator queue
and a safe manual action to respond, resume, or close the conversation. A generic
failed-job label must not hide the real hold reason.

## Issue 6: Facebook unanswered-message classes

**Status:** Confirmed mixed operational and code causes.

Among 24 recent Facebook conversations, 12 ended with a lead message and no later
delivered outbound:

- 3 had AI disabled for that conversation;
- 2 were distress safety holds;
- 3 were quality or human-review holds;
- 4 had ScheduledReply jobs fail without a delivered AI message.

The failed jobs include generated questions rejected as repeated or off-script.
These messages reached Convlo. Their silence is inside state, generation, or
egress handling, not Facebook webhook ingress.

Five recent Facebook ManyChat opener bubbles also have no Meta message IDs. Four
later received native lead replies and delivered AI responses, which proves the
conversation continued but still does not prove the stored opener row itself was
delivered.

### Current 72-hour Facebook audit

Global Facebook settings are healthy: Away Mode is on, generate-only is off,
default AI is active, response delay is 45 to 120 seconds, and debounce is 3
seconds with a 120-second maximum. No account-wide flag currently explains the
missing replies.

Nineteen conversations received lead inbound. Nine later received AI responses;
all 18 resulting outbound AI rows have Meta message IDs. Ten ended on a lead
message with no later outbound:

| Lead | Conversation | Current cause |
| --- | --- | --- |
| Ashy Elbowz | `cmu554cg4000gl00494i0tzqv` | Distress and human-review hold |
| Ifeanyi Chukwu | `cmu4jgmrd000wjv043j65u1um` | Distress and human-review hold |
| Dessy Browñ | `cmu5izhew0030jg044lkgm3vd` | Five-attempt terminal quality failure: off-script low-ticket question |
| Kada Dubois | `cmu4i4u4c0063jy04ycom87m8` | Five-attempt repeated urgency-question failure |
| Isreal Ibrahim | `cmu4om1ko000ai804slhglgej` | Five-attempt repeated-question guard failure |
| Man-zan Koua-dio | `cmu3wl6oq002kle04w7q8k57w` | Conversation AI disabled |
| Michael Keekae | `cmu3tr3gj000skz0433hprvyt` | Conversation AI disabled |
| Itz Michael | `cmu3flg3h0003jv04wufth00q` | Conversation AI disabled |
| Chris Duke | `cmu3nyuyg000klc04yuf2uq2b` | Historical No-response suppression; guard later deployed |
| Achuma Ngxola | `cmu35ml3y003vjq04ba6u260r` | Terminal quality failure and human review |

There is currently no active Facebook ScheduledReply backlog: no pending or
processing job and no retryable failed job below five attempts. This means the
current silent cases will not self-recover through the scheduler.

## Issue 7: Facebook ManyChat callback mismatch

**Status:** Confirmed code defect. The fix is deployed in PR #50. Facebook
production proof remains open.

Before PR #50, the main handoff accepted `FACEBOOK`, but:

- `/manychat-message` looks up only an Instagram lead/conversation;
- `/manychat-complete` also performs Instagram-only resolution;
- completion changes waiting flags but does not immediately and idempotently
  schedule the existing reply pipeline;
- a Facebook handoff can therefore rely on the delayed silent-stop recovery
  instead of continuing promptly.

### Required correction

- Make message and completion callbacks resolve by payload platform.
- Find the matching Facebook conversation when platform is Facebook.
- Schedule exactly one reply through the existing scheduler on completion.
- Preserve all AI-off, hold, review, and duplicate protections.

### Deployed correction awaiting production proof

- Both callbacks now accept a platform and resolve a Facebook PSID or the
  Instagram identity without running Instagram ID resolution for Facebook.
- Completion uses a deterministic ScheduledReply ID under a conversation lock.
  Callback retries adopt existing pending or processing work instead of
  creating a second reply.
- Completion no longer enables a paused conversation or changes channel
  settings. AI-off, generate-only, and Away-off conversations still enter the
  existing scheduler so it can create the same suggestion-only result as normal
  inbound; the scheduler remains responsible for preventing automatic sends.
  Active human review, distress review, scheduling conflict, terminal failure,
  expired-window, prior-outbound and uncertain multi-bubble states remain held
  or review-only.
- A proven post-send ManyChat automation callback cancels only older pending AI
  work when that automation message is still the latest event. A delayed
  callback cannot cancel a newer lead turn.
- Multiple leads matching conflicting callback identities now return an
  explicit conflict instead of selecting an arbitrary conversation.
- The missing-completion heartbeat now uses the same eligibility guard and no
  longer turns AI on by itself.
- The completion response reports `processingStatus` and `scheduledReplyId` so
  ManyChat logs distinguish scheduled, already scheduled, held and review
  cases.

## Issue 8: broad ManyChat echo classification can cancel pending work

**Status:** Confirmed risk in code. The fix is deployed in PR #50. Controlled
callback and echo-race production proof remains open. Historical incidence
remains unquantified.

Before PR #50, while a conversation was sourced from ManyChat and
`awaitingAiResponse=false`, an unmatched administrator echo could be classified
as a ManyChat outbound. That path cancelled pending ScheduledReply rows. A real
human phone reply or unrelated echo could therefore cancel AI work, especially
when the completion callback was absent or resolved the wrong platform.

### Required correction

Only classify an echo as ManyChat when it matches a provider-reported message,
stable operation ID, or narrowly bounded content/time correlation. Do not cancel
scheduled work for an uncorrelated administrator echo.

### Deployed correction awaiting production proof

- The `awaitingAiResponse=false` inference was removed.
- Echo-first classification now requires a native Meta message ID plus either
  the exact configured opener or a known automation shape inside a two-hour
  window from `manyChatFiredAt`.
- An unknown business-side echo in that automation window is stored durably as
  source-pending for two minutes. It is excluded from AI history and the visible
  conversation while its source is unresolved. The intake path can cancel older
  pending AI work to prevent a double send, but it does not record a human
  override, update training data, clear review holds, or cancel follow-up
  cascades.
- A post-send provider callback uses the same conversation lock to reclassify
  that exact pending row as ManyChat and attach its provider evidence without a
  duplicate bubble.
- A minute cron finalizes an expired pending row as a genuine HUMAN/PHONE echo.
  The human override, training counter, pending-reply cancellation and follow-up
  cancellation commit together once. It preserves distress and human-review
  holds and cannot clear state created by a newer lead message.
- An echo outside the ManyChat correlation window is stored as due-now and runs
  through that same transaction immediately. If the request stops between the
  durable insert and finalization, the cron safely completes it later.
- A provider callback arriving after human finalization returns an explicit
  conflict for review instead of relabelling the message after human-side
  effects have committed. The conflict creates one stable, deduplicated
  operator notification containing only the conversation, message and
  sanitized provider-operation identifiers. Callback retries do not create
  duplicate alerts, and raw webhook payloads or authentication keys are never
  copied into the notification.
- An authenticated callback with `sentAt` more than five minutes in the future
  or more than 24 hours old is rejected with `sent_at_out_of_range` before lead
  matching, message ordering or pending-reply cancellation can run.

## Issue 9: Instagram standby cannot be processed blindly

**Status:** Observed and intentionally audit-only.

Facebook currently processes normal messaging and standby events as conversation
activity. Instagram records standby events for audit and deliberately avoids
feeding them into AI processing. Processing all Instagram standby messages would
risk sending while ManyChat or another app owns the thread and would recreate
Meta subcode `2534037`.

A safe future path requires one of:

- an explicit, logged pass/take-control sequence before promotion;
- Meta routing that places the lead reply in normal `messaging`; or
- verified current ownership plus deduplication against normal ingress.

Until then, the dashboard should expose `activity observed under standby; routing
review required` instead of making the conversation look silently stale.

## Issue 10: failed Meta action block is separate from ownership

**Status:** Confirmed isolated error class.

Tiger's initial scheduled reply failed after five attempts with Meta code `368`,
subcode `1404169`, a temporary action block. Tiger later sent a native lead
message and received a delivered AI response with a Meta message ID. This is not
the `2534037` thread-owner failure and should not be diagnosed or retried as one.

## Issue 11: historical phantom rows can affect AI context and counts

**Status:** Confirmed compatibility risk. The correction is deployed in PR #50.
Historical rows remain preserved for audit and are now excluded from sent
history, previews, counts, and AI routing unless delivery evidence exists.

Preventing new phantom opener rows does not remove the historical rows already
stored as `MANYCHAT` messages. Hiding those rows in the dashboard is insufficient
if the scheduler still includes them in prompt history, script routing, latest
message selection, or raw message counts. The old `platformMessageId` field is
also not reliable proof of Meta delivery because earlier provider callbacks could
store a ManyChat operation ID there.

### Required correction

- Exclude historical planned or delivery-unknown ManyChat opener rows from AI
  history and routing decisions.
- Treat old ManyChat rows with a legacy `platformMessageId` as provider-reported,
  not Meta-confirmed.
- Keep historical rows for audit; do not delete or rewrite production history as
  part of this release.
- Make dashboard counts, previews, and AI context follow the same delivery-truth
  rule so an invisible phantom cannot still steer the engine.

## Issue 12: live ManyChat tag gate bypasses Convlo

**Status:** Confirmed configuration defect. A tag correction was briefly
published during test preparation, then reverted before general rollout because
the required controlled production proof had not passed. Production behavior
still needs a fresh follower proof.

The two published Instagram automations do not currently connect end to end.

### Published new-follower flow

The live `Say hi to new followers` flow runs in this exact order:

1. `User follows your account` / Follow-to-DM trigger.
2. Actions node calls
   `POST https://qualifydms.io/api/webhooks/manychat-handoff` with
   `scheduleAi:false`.
3. The special Instagram Opening DM node attempts to send
   `Hey there! Thanks for following me are you in the markets rn? or starting?`.

The current Actions node does not add the tag
`Convlo - Awaiting first reply`. The special Opening DM node has no ordinary
action after the send, so this graph cannot call `/manychat-message` after the
opener.

### Published Default Reply flow

The live `Instagram Default Reply` flow runs:

1. User sends a direct message.
2. Check whether the contact has tag `Convlo - Awaiting first reply`.
3. On the true branch, reset the response field, call
   `/api/webhooks/manychat-handoff` with
   `processingMode:"queued_first_reply"`, `scheduleAi:true`, and
   `leadResponseText:Last Text Input`.
4. Map `$.handoffAccepted` into the `Convlo handoff accepted` field.
5. Remove the tag after the accepted response.

The false tag branch does nothing. In the current safe pre-test configuration,
a fresh untagged follower can receive the opener and answer it, yet the answer
will bypass Convlo because the first flow does not add the tag required by the
second flow. This is deliberate until the controlled proof passes; it is not
the intended general-rollout configuration.

### Configuration attempt and rollback

During controlled-test preparation, `Add Tag: Convlo - Awaiting first reply`
was briefly inserted between the existing context callback and Opening DM. That
would have routed every new follower into the queued first-reply path before the
required controlled proof, so it was not kept as the general production state.

At approximately 2026-09-18 19:04 UTC, the last verified pre-test ManyChat
version was restored and published. A fresh reload verified:

1. the Actions node contains only the existing context-only external request;
2. the Actions node remains connected to the same Instagram Opening DM;
3. the opener text and endpoint are unchanged; and
4. no general `Convlo - Awaiting first reply` tag action is live.

### Safe correction and test order

- For the controlled proof, first confirm the opener exists in both Instagram
  inboxes, manually add the exact tag to that ManyChat contact, and only then
  send the first reply.
- For general rollout, after the controlled proof passes, add the tag in the
  new-follower flow before the Opening DM or replace the tag gate with the
  approved rollout condition.
- Do not add `/manychat-complete` before the lead reply. The
  `queued_first_reply` callback is already the takeover signal for this path.
- Keep the early pre-send callback context-only. Because the special opener has
  no post-send callback, its delivery must be confirmed by a native Meta echo
  or by authoritative Instagram history.

## Issue 13: no live receipt or post-deploy first-reply proof

**Status:** Open proof gap, confirmed by a read-only production audit.

Since the PR #50 deployment boundary at 2026-09-18 18:27 UTC, Daniel's
Instagram workspace has recorded:

- zero new leads;
- zero messages;
- zero ScheduledReply jobs;
- zero ManyChat handoff receipts;
- zero generation traces;
- zero egress attempts;
- zero ownership events;
- zero new Meta `2534037` or `368` failures.

Across all production workspaces, `ManyChatHandoffReceipt` still has exactly
zero rows. The durable queued path has therefore never accepted and completed a
real production intake. A separate workspace did save one phone-originated echo
as `META_CONFIRMED` after deployment, which proves the new delivery fields and
runtime are active. It does not prove the ManyChat handoff.

Five Daniel Instagram follower callbacks immediately before PR #50 created
legacy planned opener rows with no provider ID, no Meta message ID, no lead
reply, no job, and no receipt:

| Handle | Conversation | Planned opener row | Time UTC |
| --- | --- | --- | --- |
| `@squirrel.8425393` | `cmu77pjjb0003lb04vrwwnh26` | `cmu77pjqi0005lb04s3di3sz5` | 17:08:12 |
| `@deepak_parthu` | `cmu78cm6i0003lh04jipvv8tq` | `cmu78cmca0005lh0457ubb8ly` | 17:26:08 |
| `@park.her` | `cmu7987z80009lh04rqhiww2v` | `cmu79885d000blh04rkrrk4ji` | 17:50:43 |
| `@nkdesigns_gh` | `cmu7a289o000flh04sachhssy` | `cmu7a28g5000hlh042j7z1jxa` | 18:14:03 |
| `@nivekiser` | `cmu7af9bz000llh04i55ho8ne` | `cmu7af9if000nlh04jba6i1to` | 18:24:11 |

These are opener-delivery discrepancies, not AI nonresponse cases. Convlo never
received a lead answer, so the AI, scheduler, egress, and ownership paths never
started for them.

After PR #50, a fresh dashboard load of Squirrel correctly showed zero visible
messages and no opener bubble. This proves the deployed UI no longer presents
that legacy planned opener as sent. It does not prove a new ManyChat opener or
first-reply flow.

## Unresolved upstream causes of a missing Follow-to-DM opener

The exact Squirrel opener-send failure is still unproven. The following are
current platform constraints or hypotheses, not confirmed root causes for that
specific contact:

- ManyChat documents that Follow-to-DM triggers only once per follower.
  Unfollowing and following again does not rerun it.
- Meta limits a person to one Follow-to-DM message per week across Instagram
  accounts. Only the first followed account can send during that period.
- Follow-to-DM is a Meta-controlled beta and eligibility may change.
- ManyChat documents that the feature requires its current Unified Instagram
  onboarding connection; older connection methods may require reconnection.
- The opener must be visible and interacted with before the normal 24-hour
  messaging window and first-reply handoff can proceed.

Reference: [ManyChat Follow-to-DM documentation](https://help.manychat.com/hc/en-us/articles/23096654243740-Follow-to-DM-on-Instagram-Say-Hi-to-New-Followers-BETA).

## Issue 14: Facebook outbound echo subscription is missing

**Status:** Confirmed live Meta configuration defect, corrected at
2026-09-18 18:54 UTC. One real outbound echo is still required as production
behavior proof.

The connected Facebook Page `708196295710896` was subscribed to `messages`,
postbacks, opt-ins, deliveries, and reads, but not `message_echoes`. The
production token was valid and app `1441437191008347` was present on the Page
subscription.

### Consequence

- Lead inbound still reaches Convlo because `messages` is present.
- Messages sent from the Facebook Page, a phone, or ManyChat can exist on
  Facebook without an echo reaching Convlo.
- Convlo can then show an incomplete thread, schedule from stale history, or
  misattribute the next event.
- A 72-hour production sample contained zero Facebook HUMAN/PHONE echo rows.
- The health cron emitted 62 repeated alerts between September 15 at 19:30 UTC
  and September 18 at 18:00 UTC.

The current alert wording is misleading. It states that inbound DMs will not
reach Convlo even when `messages` is present and only `message_echoes` is
missing. The alert should identify the missing field and explain the actual
impact.

### Correction and proof

1. Completed: re-subscribed the Page to the existing expected field set.
2. Completed: read the Page subscription back from Graph API and verified
   `message_echoes` is present alongside `messages`, postbacks, opt-ins,
   deliveries, and reads.
3. Remaining: send one authorized Page or phone message and verify one Facebook echo row
   appears in Convlo with the Meta message ID.
4. Remaining: correct the health-alert body so it distinguishes inbound-message loss from
   outbound-echo loss.

The alert/reconnect code correction is deployed in commit
`17dd6f1d7d879e72008751fe4981d324ea524562`. Direct Instagram and Facebook
reconnect paths now use the same complete Page subscription field set, so a
later reconnect should not silently remove `message_echoes`. A real echo remains
required as end-to-end production proof.

## Issue 15: delayed ManyChat replies are routed as direct inbound

**Status:** Confirmed code defect. The correction is deployed in commit
`cb24650c877b6e69793a3c8f7df44e69dfb035f8`; conversation-level production
proof remains open.

`src/lib/script-serializer.ts` treats a conversation as ManyChat-routed only
while `manyChatFiredAt` is less than two hours old. After that window,
`resolveStep1BranchMode` explicitly returns `warm_inbound` even when the stored
conversation source is still `MANYCHAT`.

Production examples selected the branch
`Warm Inbound (DM'd directly — no ManyChat)` despite a ManyChat source:

- `@gero`: first reply approximately 95.45 hours after the opener;
- `@kenny`: approximately 47.71 hours;
- `@nico`: approximately 24.84 hours;
- `@lloyd`: approximately 4.98 hours.

Kenny then received duplicate or re-introduction behavior and ended in
`FAILED_QUALITY_GATE` with human review. These leads did reach Convlo. Their
problem is branch selection after ingestion, not a missing Meta webhook.

### Required code correction

- Preserve the ManyChat first-reply branch when the conversation source and
  durable handoff state prove it originated from ManyChat, regardless of an
  arbitrary two-hour age.
- Use real completion, prior-response, and durable receipt/message state to
  decide whether the handoff is still at the first-reply stage.
- Do not use age alone to relabel a ManyChat lead as a direct inbound lead.
- Add tests at just under two hours, just over two hours, 24 hours, and multiple
  days, plus a case that has already completed the ManyChat handoff.
- Prove one delayed controlled first reply selects the ManyChat branch and does
  not repeat the greeting or enter a quality hold.

## Issue 16: Facebook queued first-reply intake remains Instagram-only

**Status:** Confirmed code and proof gap.

PR #50 made `/manychat-message` and `/manychat-complete` platform-aware, but
`src/lib/manychat-handoff-receipt.ts` still rejects queued receipt intake unless
the platform is Instagram. Facebook therefore does not yet have parity for the
durable `queued_first_reply` path released in PR #49.

Production evidence:

- 18 historical Facebook ManyChat opener rows since September 14 have no
  provider ID, Meta message ID, or delivery status;
- 7 later received native lead replies and 7 received AI replies with Meta
  message IDs;
- 11 never received a lead reply, so opener delivery remains unproven;
- production contains zero Facebook `ManyChatHandoffReceipt` rows;
- no post-PR #50 Facebook lead or callback exists to serve as live proof.

If Facebook must use the same durable first-reply contract, receipt validation,
identity resolution, uniqueness, and worker processing must support a Facebook
PSID. This needs tests and a separate real Facebook callback proof. Message and
completion callback parity alone does not close this gap.

## Issue 17: Facebook can report terminal failure after delivery

**Status:** Confirmed code defect. The correction is deployed in commit
`c5b4893f26594e09a06dcd3761e056d2d9d765d7`; conversation-level production
proof remains open.

The inline Facebook webhook catches every processing exception and resets the
job to `PENDING`, including terminal `QualityGateEscalationError` cases. The
Instagram webhook has dedicated terminal-quality handling. Later, the reply cron
checks for delivery through another path only in its no-error path, then marks a
terminal quality failure without first reconciling whether an AI message with a
Meta message ID was already delivered.

Kenny is the production contradiction:

- the conversation contains three AI messages with Meta message IDs;
- its scheduled job is `FAILED_QUALITY_GATE`;
- `awaitingHumanReview=true` remains set.

The operator therefore sees a terminal failure and review hold even though Meta
accepted outbound AI messages.

### Required code correction

- Handle terminal quality exceptions inline on Facebook with the same explicit
  semantics as Instagram.
- Before committing a terminal failure in the cron, reconcile any AI outbound
  delivered after the triggering lead message.
- Do not clear a legitimate review hold merely because an unrelated or older
  outbound exists; the reconciliation must link ordering and trigger context.
- Add a regression test for a delivered Meta message followed by a terminal
  quality exception and assert one truthful final state.

## Working production controls

### Penguin

`@penguin.1154824` is the strongest working controlled flow:

- explicit opener has a Meta message ID;
- lead replies have Meta message IDs;
- AI replies have Meta message IDs;
- both scheduled reply jobs are sent;
- the Houston continuation received two delivered AI messages.

### Tiger

Tiger proves a later native continuation can work after an earlier failed job.
Its planned opener remains unproven because that stored row has no Meta message
ID. The later location question is independently proven delivered.

These controls demonstrate that Convlo-to-Meta delivery works in some threads.
They do not validate the first ManyChat opener or eliminate per-conversation
state, hold, and routing failures.

## What has already been corrected

- Same-turn consecutive `SEND` plus `ASK` preservation and pre-`WAIT` egress
  handling were deployed and production-proven.
- The Step 7 impossible `No response` selection guard was deployed.
- Duplicate inbound webhook resume protection was deployed.
- Ownership event logging and reconnect credential preservation were deployed.
- Durable ManyChat first-reply receipt intake, leases, retries, reconciliation,
  and background scheduling were deployed in PR #49.
- ManyChat delivery evidence, hidden pre-send opener context, provider/Meta ID
  separation, callback/echo locking, pending echo attribution, Facebook
  callback parity, and truthful UI/AI history were deployed in PR #50 at
  production commit `c962f780e7e4b3dd85391e0fa6bdeeaf81fe1c2c`.

None of those changes can make ManyChat deliver an opener that ManyChat or Meta
did not send. Convlo now keeps an unproven opener out of sent history and waits
for real provider or Meta evidence. The remaining blocker is a fresh controlled
flow in which ManyChat actually sends the opener.

## Remaining work in order

1. Run the controlled Instagram proof from a fresh follower. Confirm the opener
   in both Instagram inboxes, add `Convlo - Awaiting first reply` only to that
   authorized test contact, then send the first reply.
2. Keep the Follow-to-DM pre-send callback metadata-only. Where an ordinary
   ManyChat send node exposes a next action, place `/manychat-message` after the
   send and supply a stable provider operation ID.
3. Complete the fresh Instagram first-reply production proof from opener through
   one normal continuation, including Meta message IDs and duplicate checks.
4. Prove one authorized Facebook Page or phone outbound now reaches Convlo as a
   Meta-confirmed echo.
5. Correct delayed ManyChat first-reply routing so source and durable handoff
   state remain authoritative after two hours.
6. Decide whether Facebook uses durable `queued_first_reply`; if yes, extend the
   receipt path beyond Instagram and test it with a real Facebook PSID.
7. Align Facebook terminal-quality handling with Instagram and reconcile a
   delivered Meta message before committing terminal failure.
8. Complete the separate Facebook callback/completion production proof.
9. Add an operator recovery flow for safety/review holds and separately approved
   historical failures.
10. Produce a dry-run eligibility list for the 59 stranded ownership failures and
   other historical no-delivery turns. Review before any replay.

## Open items as of the PR #50 deployment

- **Fresh Instagram proof:** still required. Squirrel cannot serve as success
  proof because its opener never appeared in Instagram and it never produced a
  lead reply or receipt.
- **Fresh Facebook proof:** still required for platform-aware message and
  completion callbacks.
- **Facebook subscription proof:** `message_echoes` is restored on the live
  Page. One real outbound echo must still prove the end-to-end path.
- **Delayed first-reply routing:** ManyChat conversations older than two hours
  are still relabelled as direct inbound by the current script serializer.
- **Facebook receipt parity:** message and completion callbacks are
  platform-aware, but durable queued receipt intake remains Instagram-only.
- **Facebook contradictory terminal state:** a Meta-confirmed AI message and a
  `FAILED_QUALITY_GATE` job can coexist for the same processing sequence.
- **ManyChat configuration:** ordinary send nodes should report after the send;
  the special Follow-to-DM opener has no normal post-send action, so its early
  callback must remain context-only. The new-follower flow does not add the
  Default Reply tag in general production. Add it only to the controlled test
  contact until the proof passes.
- **Queued intake evidence:** production contains zero handoff receipts. The
  first-reply worker is deployed but has not completed a live production intake.
- **General rollout:** queued first-reply mode remains restricted to the
  controlled path until both production proofs pass.
- **Historical recovery:** 59 ownership failures, Rob's suppressed turn, Rade's
  stranded message, and other old no-delivery turns have not been replayed.
- **Human operations:** distress and human-review holds still need an actively
  monitored queue and an explicit resume/close workflow.
- **Test limitation:** 126 focused tests, TypeScript, Prisma validation, and the
  production build passed. The receipt integration suite was not run because no
  isolated local PostgreSQL test database was configured.

## Production closure standard

An item is closed only when its evidence bundle includes:

- exact account, lead, conversation, inbound message, and job IDs;
- deployed commit and deployment time;
- persisted callback/receipt state;
- one and only one scheduled operation;
- Meta message ID for every claimed delivered outbound;
- visibility in the real sender and recipient thread;
- correct script continuation on the next lead message;
- proof that AI-off, holds, review, and duplicates remain protected;
- an explicit record of any ManyChat or Meta configuration change.

HTTP 200, a Convlo bubble, a completed function, or a generated draft alone is
not delivery proof.
