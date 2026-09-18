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

- Application commit: `cabaeda158a81787a28503f2bc814eb17868853b`
- That deployment includes PR #49, the durable queued ManyChat first-reply
  intake and worker.
- Receipt migration `20260918170000_manychat_handoff_receipts` completed at
  2026-09-18 17:02:19 UTC.
- Daniel's account currently has Instagram and Facebook Away Mode enabled,
  generate-only disabled on both channels, default AI enabled, response delay
  45-120 seconds, and debounce 3 seconds.
- Queued first-reply mode is enabled only in the controlled test-tagged ManyChat
  callback. It has not been enabled for general new-follower traffic.

## Executive finding

There is no single cause for all unanswered messages. The confirmed classes are:

1. Convlo displays planned ManyChat opener context as a sent message even when
   Instagram has no message.
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
8. Facebook ManyChat callbacks contain Instagram-only lookup logic and can fail
   to finish the Facebook handoff correctly.
9. Instagram standby events are visible to Convlo's audit logger but are not
   safe to process as normal lead messages until ownership is proven.
10. Historical planned ManyChat opener rows can still enter AI history and raw
    database counts even after the dashboard stops rendering them as sent.

## Issue 1: phantom ManyChat opener bubbles

**Status:** Confirmed live defect. Open.

Convlo stores the opener supplied by an early ManyChat context callback as a
normal outbound `Message`. The message has no Meta message ID and no delivery
status, but the dashboard renders it as a purple `ManyChat · flow` sent bubble,
increments the message count, and uses it in the conversation-list preview.

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

### Code cause

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

## Issue 7: Facebook ManyChat callback mismatch

**Status:** Confirmed code defect. Fix implemented in the current review branch;
not deployed or production-proven.

The main handoff accepts `FACEBOOK`, but:

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

### Implemented correction awaiting deployment

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

**Status:** Confirmed risk in code. Fix implemented in the current review branch;
not deployed or production-proven. Historical incidence remains unquantified.

While a conversation is sourced from ManyChat and `awaitingAiResponse=false`, an
unmatched administrator echo can be classified as a ManyChat outbound. That path
cancels pending ScheduledReply rows. A real human phone reply or unrelated echo
can therefore cancel AI work, especially when the completion callback is absent
or resolves the wrong platform.

### Required correction

Only classify an echo as ManyChat when it matches a provider-reported message,
stable operation ID, or narrowly bounded content/time correlation. Do not cancel
scheduled work for an uncorrelated administrator echo.

### Implemented correction awaiting deployment

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

**Status:** Confirmed compatibility risk. Correction is in the current review
branch and remains undeployed.

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

None of those changes proves the ManyChat opener was actually sent. The opener
truth defect is the current blocker for the controlled first-reply test.

## Fix order

1. Correct opener truth in data, callbacks, reconciliation, and the UI.
2. Reorder the controlled ManyChat flow so the opener send precedes the
   post-send reporting callback.
3. Complete the fresh Instagram first-reply production proof.
4. Make Facebook message/completion callbacks platform-aware and schedule once.
5. Tighten ManyChat echo classification so unrelated admin echoes cannot cancel
   AI work.
6. Add an operator recovery flow for safety/review holds and separately approved
   historical failures.
7. Produce a dry-run eligibility list for the 59 stranded ownership failures and
   other historical no-delivery turns. Review before any replay.

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
