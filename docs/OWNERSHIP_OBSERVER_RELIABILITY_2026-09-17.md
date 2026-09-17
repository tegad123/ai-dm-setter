# Ownership observer reliability follow-up

Base: PR #47 at `73f64d388088e4875b885a0cf97a3120ecd9fe20`.
This follow-up changes only ownership audit persistence and normalization. No
engine, credential, schema, control-transfer API, or Meta configuration changes.

## Changes

1. Persist ownership audit events across the entire webhook delivery before
   normal handlers run. If an audit write fails, return 503 before any inbound,
   echo, deletion, notification, or scheduling side effects. Meta can redeliver;
   the existing payload hash unique index and skipDuplicates suppress audit rows
   already persisted by an earlier partial preflight.
2. Keep requested_owner_app_id in the raw payload instead of labeling it as
   newOwnerAppId. Only explicit new-owner fields populate that column.
3. Exercise the real extractor, hashing and persistence wrapper in the route
   tests, with only database and external processing boundaries mocked.

## Operational behavior

A mixed delivery is delayed if its audit persistence fails, even when it also
contains ordinary messages. This is intentional: message effects must not run
before a retryable audit failure. Recovery depends on Meta redelivery and the
underlying database returning to health. Audit-only failures no longer receive
false success acknowledgements. Unknown/unconnected account rejection and
existing errors after normal processing starts keep their previous behavior.

Deploy PR #47's migration before subscribing to handover/standby. This patch
adds no migration. It does not identify historical owners or acquire control.
Keep the incident open until a controlled production test supplies real events
and subsequent send evidence.

## Verification

- 24 targeted tests pass: the original 18 plus six regressions.
- Full TypeScript check passes using an isolated client generated from this
  schema (no database connection); shared dependency files were not regenerated.
- Storage outage and repeated audit-only redelivery: 503, then one audit row.
- Later-entry outage: earlier normal messages, echoes and deletions do not run;
  after recovery, saved audit rows deduplicate and normal work runs once.
- Mixed-entry outage: standby stays audit-only after successful retry.
- Request-only notifications do not populate newOwnerAppId in messaging,
  standby or changes envelopes; raw requester information remains available.
- Tests run without real database or Meta calls. No production build/migration
  was run. Local disk limits required reusing existing dependencies.
