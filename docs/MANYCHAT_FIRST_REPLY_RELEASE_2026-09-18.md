# Reliable ManyChat first-reply handoff

## Scope and baseline

Built from main `3a7c03d8d1bf043e0eec04e075409a5b8d1d52ed` on
`codex/manychat-durable-first-reply`. Authorized by Tega's implementation plan.
The change addresses callback timeouts by acknowledging durable intake before
background scheduling. It does not change AI prompts, script branches, Meta
routing, credentials, standby policy, or manual-message delivery.

## Changed behavior

- `/api/webhooks/manychat-handoff` accepts opt-in
  `processingMode: "queued_first_reply"` for Instagram with `scheduleAi: true`
  and a nonempty first answer. Existing requests use the legacy path.
- Authentication and validated receipt persistence precede HTTP 200. No external
  identity lookup, eight-second wait, generation, or delivery runs in intake.
  `handoffAccepted: true` means recorded, never delivered. Database failure is 500.
- One receipt per account/platform/subscriber. Identical semantic retries reuse
  it; changed content is 409. `firedAt` differences alone are not conflicts.
  Unknown payload fields and authentication headers are not retained.
- An authenticated one-minute cron claims up to three receipts per invocation
  with atomic leases. Interrupted leases expire after five minutes. Transient
  processing failures retry after 1, 5 and 15 minutes, then require review.
- Context and message links commit together. Existing native Meta messages are
  reused. A persisted `nativeInboundOwned` flag selects the scheduling owner:
  native-owned input is only reconciled against native work, never independently
  queued by the worker. Worker-owned input can absorb its later native copy
  without triggering another native scheduler.
- Queue-only entry to `scheduleAIReply` persists a ScheduledReply and returns.
  Existing cron generation, script routing and delivery guards remain in charge.
  It preserves the response-delay distribution and collection/debounce timing,
  with the additional receipt-cron interval. Queue failure never falls through
  to inline generation or sending.
- Receipt outcomes are `QUEUED`, `ALREADY_HANDLED`, `RETRY`, `HELD`, or
  `NEEDS_REVIEW`. QUEUED is an intake outcome, not a delivery status. Inspect its
  linked ScheduledReply and Meta message IDs for delivery. Terminal outcomes
  and operator notifications commit atomically. Reasons are sanitized codes.
- Holds, failed/uncertain/partial delivery, expired windows and prior replies
  do not trigger replay. Meta 368/2534037 stay delivery failures in the existing
  pipeline. This worker neither rotates credentials nor takes thread control.

## Preconditions and limits

The original context-only ManyChat opener callback must already have created
the contact and matching opener. The worker retries missing context, then asks
for review; it does not race native ingress to create a new contact. Keep the
existing follower opener callback (`scheduleAi:false`) enabled.

Native/ManyChat input matching uses account, conversation, text and a five-minute
receipt window because the current callback carries no native Meta message ID.
Ambiguous identities and changed first replies require review. If matching text
arrives after an outbound while the first reply still has no native message ID,
the new input is saved and the conversation is held for human review with an
operator notification. It is neither silently discarded nor automatically answered.
This release is
not a historical recovery tool or a general repeated-message deduplicator.
Callbacks arriving well after their native event need separate investigation.

Three receipts per minute is the initial worker capacity. Monitor oldest pending
receipt and backlog before broad rollout; one cron interval assumes no backlog.
  Native-owned input with no surviving native work becomes review, not a replay.

## Files and migration

- `prisma/schema.prisma` and
  `prisma/migrations/20260918170000_manychat_handoff_receipts/migration.sql`:
  additive receipt table, unique intake identity, status/retry/lease indexes.
- `src/lib/manychat-handoff-receipt.ts`: durable acceptance and deduplication.
- `src/lib/manychat-handoff-worker.ts`: leases, reconciliation, context, retries,
  queue invocation and notifications.
- `src/lib/manychat-handoff-queue.ts`: queue-only scheduling boundary.
- `src/lib/manychat-inbound-reconciliation.ts`: shared locked input matching.
- `src/lib/webhook-processor.ts`: narrow integration hooks for queue-only
  scheduling and ManyChat-native message reuse.
- `src/lib/manychat.ts`: optional abort signal for bounded subscriber lookup.
- `src/lib/manychat-handoff.ts`: optional processingMode schema field.
- Handoff API route, new cron route, and `vercel.json`: routing/auth/schedule.

## Validation

81 targeted checks passed: receipt worker 26, queue/native reconciliation 32,
existing Instagram webhook acknowledgement 14, isolated PostgreSQL integration 9.
Integration includes actual HTTP handler calls, six simultaneous acceptance
attempts, database failure, conflicting payload, native-first/worker-first
ownership, simultaneous persistence, committed-job interruption, auth/pause and
legacy Instagram/Facebook context callbacks and ambiguous post-delivery native
copies held for review. Six concurrent local acknowledgements
completed in under 300ms in the final run; production latency remains to be proved.

The migration was applied twice inside an isolated local PostgreSQL transaction;
indexes, defaults and idempotence passed, then the transaction was rolled back.
Tests never used client production data. TypeScript, Prisma validation and build
passed. Build warnings concern existing optional OpenTelemetry externals,
baseline-browser-mapping data and workspace root detection. The production concurrent test is
still required; local tests do not prove Meta delivery.

A locally imposed 3GB Node heap cap caused one build to fail during TypeScript;
the complete build passed when rerun with a 6GB cap. Standalone TypeScript also
passed. No application changes were needed for that memory limit.

Worker-owned input follows the existing callback-style persistence path, not all
native ingress hooks (immediate email/geography extraction, inbound broadcasts,
and early cold-pitch classification). Existing generation/send safety guards
remain authoritative. Native-owned input continues through native processing.

## Test-only ManyChat change

Workspace `fb2940357`, Instagram Default Reply, content
`content20260918151817_348241`, guarded by tag **Convlo - Awaiting first reply**.
Keep its existing key, endpoint and native variable-picker values. Add
`"processingMode":"queued_first_reply"`. Change response mapping from `$.ok` to
`$.handoffAccepted` into **Convlo handoff accepted**. Keep the reset-to-No and
remove-tag-only-on-true condition. Do not broaden the follower trigger yet.

The successful test must show original opener, first lead answer, accepted
receipt, one scheduled response operation, Meta message IDs, then normal
continuation. Use a fresh authorized test contact. Tiger/Penguin's earlier
successful continuations do not close this first-reply proof.

## Rollback

Disable the test callback's new intake if validation fails. Set
`MANYCHAT_QUEUED_HANDOFF_PAUSED=true` in the deployed environment to pause both
acceptance and worker processing. Verify the cron reports paused and intake
returns 503. In-flight work already handed to ScheduledReply remains governed
by that pipeline and must be inspected separately. Preserve receipts and the
additive table. Do not resend them through the legacy path or bulk-replay failed
messages. Do not delete receipt rows to rerun a test.

## Rollout log

- Initial production baseline: `3a7c03d8d1bf043e0eec04e075409a5b8d1d52ed`.
- Implementation and local checks complete; deployment verification and live
  ManyChat test are pending at the time this initial release note is committed.
- General new-follower rollout remains gated on controlled concurrent
  Meta/ManyChat production proof.
