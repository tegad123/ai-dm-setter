# Incident: ManyChat opener shown as sent when Instagram received nothing

## Status

Code correction deployed in PR #50 at production commit
`c962f780e7e4b3dd85391e0fa6bdeeaf81fe1c2c`. The incident remains open for the
fresh controlled Instagram proof. The original discrepancy was confirmed in
production on 2026-09-18 with `@squirrel.8425393`; that historical test remains
valid evidence and was not replayed or rewritten.

This incident is separate from the AI engine, sales script routing, Meta thread
ownership, manual-message recovery, and the durable first-reply callback released
in PR #49. Those systems may have their own failures, but none is needed to
explain the Squirrel discrepancy.

## User-visible problem

Before PR #50, Convlo presented a ManyChat opener as a delivered outbound message
even when the opener was absent from the real Instagram thread. Operators could
not use a purple `ManyChat · flow` bubble or the conversation message count as
proof that the lead received the message. The deployed correction now keeps
pre-send opener context out of delivered history until provider or Meta evidence
exists.

This created two misleading symptoms:

1. Convlo appears to have started a conversation that does not exist on Instagram.
2. The AI appears stale or non-responsive, although the lead never received an
   opener and therefore had nothing to answer.

## Controlled production evidence

Test account and records:

- Instagram handle: `@squirrel.8425393`
- ManyChat subscriber ID: `2078481927`
- Convlo lead ID: `cmu77pjja0001lb04ycrhqrg2`
- Convlo conversation ID: `cmu77pjjb0003lb04vrwwnh26`
- Test began: 2026-09-18 at approximately 12:08 PM America/Chicago
- Production application commit: `cabaeda158a81787a28503f2bc814eb17868853b`

Observed in ManyChat:

- The contact appeared immediately after following `@daetradez`.
- The `Say hi to new followers` automation was recorded as triggered at 12:08 PM.
- The contact remained a `Visitor` and was reported as inactive.
- The ManyChat inbox contained the automation-trigger system event but no opener
  message bubble.
- Attempting to add the controlled-test tag returned `The contact is not active`.
- The general ManyChat error log contained no new error tied to this attempt at
  inspection time.

Observed in Convlo:

- A new Instagram conversation was created with source `MANYCHAT`.
- `manyChatOpenerMessage` contained: `Hey there! Thanks for following me are you
  in the markets rn? or starting?`
- The UI displayed that text as a purple outbound `ManyChat · flow` bubble.
- The conversation summary labelled it `Outbound` and reported one message.
- The AI setter count was zero and no first-reply receipt existed.

Observed in Instagram while signed in as `@daetradez`:

- Searching for `@squirrel.8425393` opened thread
  `https://www.instagram.com/direct/t/18103907582101004/`.
- The thread had no messages. The composer was visible immediately below the
  profile header with no message history between them.
- The test account owner also reported that the opener was absent on Squirrel's
  Instagram account.

Working-case comparison:

- `@tiger.86205757` was opened in the same authenticated `@daetradez` Instagram
  inbox, eliminating a different-account or stale-session explanation.
- Tiger's thread contained the ManyChat opener, the lead's replies (`Starting`,
  `I'm just starting with trading`, and `Hey, I'm new to trading and looking to
  get started`), and Convlo's AI reply `bet bro, where are you currently based
  out of?`.
- Instagram marked Convlo's AI reply as seen. Earlier production evidence links
  it to conversation `cmu74l19s000rkz04u1ys2ql5` and a successful Meta message
  ID.
- Therefore the Daetradez Instagram inbox and Convlo delivery integration can
  work. The discrepancy is per conversation/event, not a total platform outage.

Production scope sampled at approximately 12:30 PM America/Chicago:

- In the preceding 24 hours, Daniel's workspace created 83 conversations.
- 66 were Instagram conversations with source `MANYCHAT`.
- 64 of those 66 contained exactly one `MANYCHAT` opener row, no lead response,
  and no `platformMessageId`. Those rows are unverified; the database cannot say
  which were delivered and merely unanswered versus never sent.
- Only the Tiger and Penguin controlled conversations progressed beyond that
  one-row state in the same window.
- A second direct Instagram comparison, `@xo8nx`, also showed an empty real
  Instagram thread while Convlo displayed the opener as an outbound ManyChat
  bubble. This confirms the Squirrel result was not an isolated UI refresh issue.
- The ownership audit contained 69 Instagram standby-channel events in the same
  period: 42 `standby_message` and 27 `standby_event`. Standby traffic is audited
  but intentionally does not enter the Instagram AI pipeline.

The count of 64 is the size of the unverified population, not proof that all 64
failed delivery. The two browser comparisons prove at least Squirrel and xo8nx
were false sent-looking messages.

Conclusion from this evidence:

- ManyChat successfully ran the first external callback that supplies opener
  context to Convlo.
- Convlo persisted that context as an outbound message before ManyChat had proven
  that Instagram accepted or delivered the opener.
- The opener was not present in the authoritative Instagram thread.
- This test does not show Meta error `2534037`, error `368`, or any other send
  error because no corresponding failed Meta send event was observed.
- This test does not reach the new queued first-reply path. There was no lead
  reply and no `ManyChatHandoffReceipt`.
- Tiger proves that a real opener can create a normal lead response and a
  delivered Convlo continuation; it does not make Squirrel's phantom opener
  valid.

## Confirmed causal sequence

The published new-follower flow currently runs in this order:

1. Instagram follow triggers ManyChat.
2. ManyChat calls `POST /api/webhooks/manychat-handoff` with
   `scheduleAi:false` and the planned opener text.
3. Convlo creates the lead/conversation and stores the opener as an outbound
   `Message`.
4. ManyChat proceeds to its Instagram `Send Message` step.
5. If the send never happens or fails, Convlo still shows step 3 as though step 4
   succeeded.

The callback proves only that ManyChat intended to run the opener flow. It does
not prove the opener was accepted by Meta, delivered to the Instagram thread, or
visible to the lead.

## Required corrections

### 1. Correct the ManyChat flow order

For flows that support an action after their send node, the opener must be sent
before Convlo is told that it was sent:

1. ManyChat `Send Message` opener.
2. On successful continuation of that step, call the Convlo context callback.
3. Include a stable ManyChat message/operation identifier and send timestamp if
   ManyChat exposes them.
4. Keep the callback `scheduleAi:false`; it records the opener and waits for the
   lead's first answer.

If ManyChat cannot provide a delivery receipt, Convlo must call the result
`sent by ManyChat` or `send unverified`, not `delivered`.

The published Follow-to-DM flow currently uses a special Opening DM node with the
Convlo Actions node before it and no ordinary immediate post-send next step.
Therefore its early callback must remain context-only and must not create a
visible message. A native Meta echo can confirm the opener later. A real first
lead reply proves that the conversation can continue and must not be held merely
because a separate opener row is absent.

### 2. Separate planned context from delivered message history

Convlo must not create a normal outbound message solely from `openerMessage` in
the pre-send context callback. Store it as conversation context or give it an
explicit pending/unverified delivery state. It can become visible as a normal
outbound bubble only after one of the following:

- a ManyChat callback that runs after the send step and supplies a stable message
  identifier;
- a ManyChat outbound-message callback with a deterministic message ID; or
- authoritative Meta history confirms the message.

The UI must visibly distinguish `planned`, `sent/unverified`, `delivered`, and
`failed`. The conversation-list preview and message count must follow the same
rule as the thread view.

### 3. Preserve the first-reply handoff

After a real lead answer, the test-tagged Default Reply callback should send:

- `processingMode: "queued_first_reply"`
- `scheduleAi: true`
- the opener text and the lead's answer

`$.handoffAccepted` means durable receipt acceptance only. Delivery proof still
requires the linked scheduled reply to finish with a Meta message ID.

### 4. Add production-grade evidence fields

For every externally originated outbound message, retain:

- source system (`MANYCHAT`, `CONVLO_AI`, `CONVLO_HUMAN`);
- source message/operation ID;
- requested, accepted, sent, delivered and failed timestamps where available;
- Meta message ID;
- sanitized error code/subcode;
- delivery owner and thread-control state when Meta supplies them.

Convlo should never infer delivery from a callback returning HTTP 200 or a
function returning without throwing.

### 5. Correct Facebook callback parity

The main handoff accepts Facebook, but the current `/manychat-message` and
`/manychat-complete` handlers still perform Instagram-only lead lookup. Their
payloads and resolution logic must be platform-aware. A Facebook completion must
find the same Facebook conversation and enqueue one idempotent reply instead of
only setting a waiting flag and relying on delayed recovery.

The current review branch implements this correction. Completion now queues a
deterministic reply through the ScheduledReply pipeline. AI-off, generate-only,
and Away-off still produce the existing suggestion-only outcome without changing
settings; active review, scheduling-conflict and terminal-failure states remain
held. This remains unproven until deployment and a real Facebook callback test.

### 6. Keep Instagram standby safe and observable

Facebook currently processes both normal `messaging` and `standby` events as
conversation activity. Instagram deliberately treats standby as audit-only to
avoid replying while another app owns the thread. Processing every Instagram
standby event blindly would recreate the `2534037` ownership failure.

For an Instagram conversation that stalls, correlate the sender ID with
`InstagramOwnershipEventLog`. If the lead reply arrived only under `standby`,
either the Meta/ManyChat flow must explicitly pass control before the reply, or a
future standby promotion must require verified ownership and deduplicate against
normal `messaging`. Until then the operator UI should state that activity was
observed under standby and requires routing review.

## Closure proof

Do not close this incident until one fresh authorized Instagram account proves
all of the following:

1. The opener is visible in the test account's Instagram inbox.
2. The same opener appears once in `@daetradez`'s Instagram thread.
3. Convlo either shows one opener with traceable provider/Meta evidence and a
   truthful status, or keeps the planned opener out of sent history when that
   evidence is unavailable.
4. The lead's first answer creates exactly one durable receipt.
5. Exactly one scheduled AI reply is created.
6. The AI reply receives a Meta message ID and is visible on both Instagram
   accounts.
7. A normal next lead message continues the correct script branch.
8. A concurrent native Meta webhook and ManyChat callback do not duplicate the
   lead message or AI response.

## Rollout constraint

Do not enable the queued first-reply mode for general new-follower traffic until
the opener truth problem is corrected and the closure proof above passes. The
currently published queued mode remains restricted to the existing controlled
test-tag path.

## Deployment verification

- PR: `#50`
- Production commit: `c962f780e7e4b3dd85391e0fa6bdeeaf81fe1c2c`
- Merge time: 2026-09-18 18:26:58 UTC
- Vercel deployment: successful
- Fresh authenticated production reload: successful; the conversation API and
  dashboard returned current channel data using the additive delivery-evidence
  schema.
- Full closure remains gated on the fresh Instagram proof listed above.
