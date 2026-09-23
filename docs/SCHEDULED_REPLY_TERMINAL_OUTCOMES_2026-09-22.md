# Scheduled Reply Terminal Outcomes

Date: 2026-09-22

## Release gate

This change closes the first observability prerequisite in the pre-launch QA
handoff. A scheduled reply can no longer reach a terminal state without a
machine-readable reason and terminal timestamp through a normal production
path. The row also records the conversation state at claim time and links to
the generation trace that produced its reply.

## Data model

`ScheduledReply` now stores:

- `terminalReasonCode`: the explicit reason for `SENT`, `CANCELLED`, `FAILED`,
  or `FAILED_QUALITY_GATE`.
- `terminalAt`: when the terminal decision was made.
- `claimSnapshot`: the latest lead message, cursor, stage, selected branch, and
  conversation update time seen when the worker claimed the row.
- `generationTraceId`: the `GenerationTurnTrace` associated with that job.

The migration labels old terminal rows as historical. It does not infer a
specific reason from free-text errors:

- `HISTORICAL_SENT`
- `HISTORICAL_QUALITY_GATE`
- `HISTORICAL_FAILED_UNKNOWN`
- `HISTORICAL_CANCELLED_UNKNOWN`

## Runtime coverage

The structured outcome helper is used by the cron worker, Instagram and
Facebook inline workers, webhook processor, manual sends, AI pause handling,
ManyChat echo finalization, delivery reconciliation, duplicate suppression,
and the one-off recovery scripts. Retry transitions clear stale terminal
fields. Claims use an atomic status update and persist their state snapshot.

Generation calls made on behalf of a scheduled reply pass its ID into the
generation trace recorder. The recorder links the created trace back to the
queue row on a best-effort basis, preserving the existing reply path if trace
storage is unavailable.

## Monitoring

Run the read-only production check with:

```bash
NODE_PATH=$PWD/node_modules npx tsx scripts/verify/scheduled-reply-terminal-outcomes.ts
```

Set `HOURS` to change the default 24-hour window. The check fails if any
terminal row in the window lacks a reason or terminal timestamp and reports
claim and generation-trace coverage separately.

The reply pipeline health and conversation watcher scripts also display the
new terminal, claim, and trace fields.

## Validation

- Prisma schema validation passed.
- The migration applied successfully to the local development database.
- TypeScript passed with no errors.
- The production Next.js build passed.
- The unit suite ran 894 tests: 884 passed and the 10 known baseline failures
  remained unchanged.
- Focused scheduled-reply lifecycle tests passed, including terminal data,
  retry clearing, claim snapshots, structured no-send classification, webhook
  acknowledgement, and ManyChat message truth.

## Operational scope

This release does not change client settings, Meta or ManyChat routing, or
replay any historical message. It adds evidence to the existing delivery
lifecycle so the remaining release gates can be diagnosed and closed with
row-level proof.

## Production evidence

To be completed after deployment:

- Running commit:
- Migration status:
- Terminal-outcome health window:
- Missing structured outcomes:
- Claim snapshot coverage:
- Generation trace linkage:
