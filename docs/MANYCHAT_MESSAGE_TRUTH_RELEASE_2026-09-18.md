# ManyChat message-truth and callback-parity release

## Purpose

This release corrects the gap between a message planned or reported by
ManyChat and a message confirmed by Meta. It also makes the ManyChat message and
completion callbacks work for Facebook as well as Instagram.

The release does not change the AI prompt, sales script, script branches, or
Meta conversation-routing configuration. It does not replay historical failed
messages.

## Problems corrected

1. The early handoff callback created a visible outbound opener before
   ManyChat or Meta proved that it was sent.
2. ManyChat provider IDs and Meta message IDs could occupy the same database
   field, making delivery claims unreliable.
3. A native Meta echo and a ManyChat provider callback could race and create
   duplicate bubbles.
4. An unknown business-side echo could be treated as a human response before
   its ManyChat source was known, changing training, review, and scheduling
   state irreversibly.
5. Historical planned opener rows could still enter AI history and message
   counts even when hidden from the dashboard.
6. Facebook message and completion callbacks used Instagram-only contact
   resolution.
7. Completion did not immediately and idempotently enter the existing reply
   scheduler.
8. A delayed ManyChat callback could cancel reply work created for a newer lead
   turn.

The full production evidence and all known unanswered-message classes are in
`docs/INCIDENT_RESPONSE_GAPS_2026-09-18.md`.

## Database migration

Migration: `20260918193000_message_delivery_evidence`

The migration adds:

- `Message.providerMessageId` for the ManyChat operation/message identifier;
- `Message.deliveryStatus` with `PLANNED`, `PROVIDER_REPORTED`,
  `META_CONFIRMED`, and `FAILED`;
- provider report, Meta confirmation, failure, and sanitized error fields;
- durable echo-attribution due/finalized timestamps;
- a per-conversation provider-message uniqueness constraint;
- delivery and attribution worker indexes.

Existing messages are not rewritten. Historical ManyChat rows remain
unverified unless they have an explicit new delivery status. A legacy
`platformMessageId` is treated as provider-reported because older code could put
a ManyChat ID in that field.

## Runtime behavior

### Handoff and first reply

- The early handoff stores opener text only as conversation context.
- The handoff and receipt worker no longer manufacture a visible opener
  `Message`.
- A real lead first reply can be processed with the saved opener as hidden AI
  context even when no opener bubble has been confirmed.
- Existing receipt leases, retry bounds, holds, terminal-failure protection,
  and duplicate reconciliation remain authoritative.

### Provider report and Meta confirmation

- `/api/webhooks/manychat-message` accepts Instagram or Facebook identity.
- The callback records `PROVIDER_REPORTED`; it does not claim a Meta delivery.
- A native Meta echo upgrades the same row to `META_CONFIRMED`.
- Provider-first and echo-first arrivals serialize under the same conversation
  advisory lock and converge on one row.
- Conflicting callback identities return `409 contact_identity_conflict`.

### Unknown business-side echoes

- Inside the ManyChat correlation window, an unknown echo is stored as
  source-pending for two minutes and excluded from the UI and AI history.
- The provider callback can resolve it as ManyChat during that interval.
- Outside that interval, the echo is due immediately for the same atomic
  finalizer used by the cron.
- Human override/training changes, waiting-state changes, and cancellation of
  older reply/follow-up work commit with the human finalization marker.
- The finalizer does not clear distress or human-review holds and does not
  cancel work created for a newer lead turn.
- A provider callback that arrives after human finalization returns
  `409 echo_attribution_already_finalized` for review and creates one
  duplicate-safe operator notification without storing the webhook key, raw
  payload, or message text.
- A supplied `sentAt` more than five minutes in the future or more than 24
  hours old is rejected before contact lookup or state changes, so a bad clock
  cannot reorder the conversation or cancel current work.

### Facebook completion

- `/api/webhooks/manychat-complete` resolves the requested platform.
- It creates or adopts one deterministic ScheduledReply under a conversation
  lock.
- Active human review and scheduling conflict remain hard holds.
- AI-off, generate-only, and Away-off settings are not changed. Eligible work
  enters the existing scheduler, which preserves its normal suggestion-only or
  send decision.
- Terminal failures, existing outbound work, expired windows, and uncertain
  message groups are not replayed.

### Dashboard and AI history

- Planned opener context is excluded from sent history, inbox preview, message
  counts, and AI routing.
- Provider-reported messages appear with an amber unconfirmed status.
- Meta-confirmed messages display as confirmed.
- Failed evidence remains visible as a red audit event and is excluded from
  conversational counts.
- Source-pending echoes remain hidden until attribution completes.
- Only explicitly provider-reported or Meta-confirmed ManyChat messages can
  enter AI history.

## Scheduled worker

Vercel runs `/api/cron/finalize-manychat-echoes` once per minute with the
existing `CRON_SECRET` authentication pattern. The worker processes at most 25
due rows per run and uses the same advisory lock as the provider callback.

## ManyChat configuration after deployment

1. Keep the Follow-to-DM pre-send handoff action as context-only. The special
   Opening DM node does not expose an ordinary post-send action.
2. For ordinary Send Message nodes that expose a next action, call
   `/api/webhooks/manychat-message` afterward with the exact text and a stable
   provider ID when available.
3. Send `platform: "facebook"` and the Facebook contact identity for Facebook
   message and completion callbacks.
4. Finish a controlled flow with `/api/webhooks/manychat-complete`.
5. Keep queued first-reply mode restricted to the controlled test path until
   both Instagram and Facebook production proofs pass.

## Validation completed before deployment

- 126 focused tests passed across handoff intake, worker recovery, callback
  parity, contact conflicts, callback/echo races, provisional attribution,
  delivery presentation, and AI-history filtering.
- TypeScript passed.
- Prisma schema validation passed.
- Production build passed.
- Diff whitespace validation passed.
- The receipt integration test was not run because this worktree has no
  isolated local PostgreSQL test database. Production data was not used as a
  substitute.

## Production proof required

Do not call this release fixed until a fresh authorized Instagram test proves:

1. the actual opener is visible on both Instagram accounts;
2. Convlo shows no planned opener as sent;
3. the first lead answer creates one receipt and one reply job;
4. the AI reply has a Meta message ID and is visible on both accounts;
5. the next lead response follows the correct script branch;
6. no duplicate appears when Meta and ManyChat callbacks overlap.

Run a separate Facebook test proving platform resolution, one deterministic
reply job, one delivered Meta message ID, and normal continuation.

## Rollback

- Disable the new callback configuration before reverting application code.
- Pause the echo-finalizer cron if attribution behavior is suspect.
- Preserve all new evidence and pending-attribution rows for audit.
- Do not replay callbacks or historical messages through a legacy route.
- The migration is additive; rollback does not require deleting columns or
  evidence rows.
