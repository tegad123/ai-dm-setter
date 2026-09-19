# Automated delivery reliability verification

## Code defects corrected

- Facebook repeated every failed physical text send up to three times, including
  permanent permission/token rejections. Facebook and Instagram now share the
  existing Instagram retry policy: at most three sends, with 1s and 2s delays,
  only for explicitly transient failures. Uncertain transport failures are not
  automatically repeated inside the physical sender.
- Scheduled messages previously retried non-transient ownership/action blocks,
  and only notified operators for Meta codes 10, 190 and 200. All explicit
  non-retryable provider rejections now end the job immediately. Exhausted
  temporary/internal failures also generate the existing deduplicated operator
  notification. The notification asks operators to inspect delivery evidence;
  it does not assert that an uncertain send was never delivered.
- The scheduler correctly cancelled a reminder after call confirmation or a
  fresh lead/human response, then overwrote that cancellation as FIRED with an
  unrelated AI-inactive reason. Those cancellation rows now keep their original
  status and reason.

## Local evidence

28 targeted tests passed across `meta-delivery-retry`, `meta-delivery-errors`,
`meta-messaging-window`, and `scheduled-message-failure`. They cover the shared
physical retry loop, permission/token/action/ownership rejection dispositions,
retry exhaustion, returned message IDs, 24-hour boundaries, and HUMAN_AGENT
operator-only enforcement. Standalone TypeScript and the production Next build
passed. The build reports the existing optional OpenTelemetry external-package
warnings, baseline-browser-mapping age warning and workspace-root warning.

These tests use simulated delivery operations and existing pure guards. They do
not prove live Meta acceptance, notification receipt by a human, or a complete
ManyChat lead journey. No production rows, platform settings or messages were
changed during this verification. Code push triggers the normal deployment.

## Remaining proof and limits

- Verify the deployed commit separately. A real authorized in-window lead is
  still needed to prove the opener, handoff, correct continuation, native Meta
  message ID and inbox delivery.
- The scheduled-message delivery check still precedes generation. A job close
  to the 24-hour boundary can reach Meta after the window closes; Meta's rejection
  then produces terminal review. No HUMAN_AGENT bypass is used.
- The send and database write are separate operations. A crash after provider
  acceptance but before persistence still requires evidence reconciliation;
  these changes do not introduce an exactly-once external send guarantee.
- Internal scheduled-job errors retain the existing maximum of three attempts.
  Operator notifications use the existing best-effort, per-lead deduplicated
  channel.
