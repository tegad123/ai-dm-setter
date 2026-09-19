# ManyChat first-reply identity audit, September 19

## Proven defect and correction

When a Facebook queued-first-reply callback had no matching page-scoped user
ID (PSID), the receipt worker fell back to the callback's display name. If an
unrelated same-name Facebook lead had an unresolved recipient ID and matching
opener context, the worker could overwrite that lead's recipient ID, attach the
new answer to its conversation, and queue a reply. Facebook display names are
not unique identity keys.

`src/lib/manychat-handoff-worker.ts` now restricts handle fallback to Instagram.
Facebook requires its PSID match within the same account and platform. Missing
original context retains the existing bounded retry and review behavior. The
Instagram username recovery path and valid Facebook PSID path are unchanged.

The regression failed before the change. It now proves that both an unresolved
same-name recipient and a different valid same-name recipient remain untouched,
with no linked conversation, new message, external lookup, or scheduled reply.
An additional local PostgreSQL integration test proves the unresolved-recipient
case through the actual authenticated intake handler and receipt worker.

## Pipeline audit boundaries

- Context-only handoff saves the planned opener independently of visible sent
  history. A callback acknowledgement does not establish opener delivery.
- Queued intake commits one account/platform/subscriber receipt before accepting
  the first reply. Semantic duplicates converge; conflicting answers are rejected.
- The receipt worker requires original opener context, resolves a platform
  recipient, persists or reuses the lead input, and reconciles existing work
  before requesting queue-only scheduling. A lease fences receipt mutations.
- Native ingress and the worker share a conversation advisory lock. Native-owned
  inputs keep native scheduling ownership; worker-owned inputs can absorb a
  later native message ID. Ambiguous same-text input after an outbound is held.
- The first-reply queue rechecks current lead input, holds, account settings,
  message window, outbound evidence, and active jobs. Its deterministic job ID
  and the database's one-pending-job constraint prevent duplicate pending work.
- The completion callback resolves platform-specific identity and queues the
  current lead turn through the existing scheduled-reply pipeline. The message
  callback retains external delivery evidence separately from planned context.
- Scheduled generation and physical Meta sends remain downstream. A queued
  receipt alone does not prove generation, ownership, Meta acceptance, or inbox
  delivery.

## Validation

- ManyChat unit battery: **130 passed, 0 failed**.
- Actual local PostgreSQL handoff integration: **12 passed, 0 failed**, including
  concurrent intake, native/worker races, interrupted enqueue, paused intake,
  Instagram/Facebook callback compatibility, and the new identity regression.
- TypeScript: passed. Prisma schema validation: passed.
- Production Next.js build: passed in the shared worktree with this correction
  present. Existing optional OpenTelemetry externals, browser-mapping data,
  and workspace-root warnings remain. A redundant build attempt was stopped by
  Next's build lock while that shared build ran; no second build was needed.
- The first integration invocation omitted the local database username and
  failed before fixture creation. The corrected explicit localhost connection
  passed all tests and fixture cleanup.
- The current `.env` database URL is remote despite the older runbook describing
  it as local. Integration explicitly used `127.0.0.1:5432/qdms_test`; no client
  production rows were used or changed.

## Remaining external proof

This correction does not explain or fix an opener that ManyChat never sends.
Full Instagram closure still requires one controlled contact with a real opener
visible in Instagram, one first-reply receipt and scheduled response, a Meta
message ID for that response, inbox visibility, and correct next-turn script
continuation. No browser, ManyChat/Meta configuration changes, or real messages
were used during this audit. There is no new production conversation trace or
delivery claim for this code correction.
