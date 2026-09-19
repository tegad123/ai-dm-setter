# Morning packet — 2026-09-19

## Current status

The ManyChat first-reply integration is **not yet recovered for general traffic**. A controlled test now isolates the failure precisely:

- Instagram accepts the test account's DM.
- ManyChat receives it and triggers `Instagram Default Reply`.
- The tagged action path calls the configured Convlo handoff endpoint.
- Convlo records no new message or AI work, and the tag is not removed.

That means the failure is at the callback response or durable receipt intake boundary, before the AI engine, script routing, or Meta delivery.

The live follow-to-DM flow also has two confirmed configuration gaps: it runs the Convlo External Request before its native Instagram opener action, and it does not add `Convlo - Awaiting first reply`. The Default Reply handoff is gated by that tag. This means an ordinary new follower is not reliably handed from the opener to Convlo when they answer.

## Production release already completed

Production is on `c485a0f070436cfd1e836e3a195471f5f51db259`.

- Rejects an identity-less Facebook queued handoff instead of matching a same-named person.
- Stops retries for permanent Meta delivery rejections and surfaces terminal delivery failures.
- Prevents pricing/product questions containing a dollar amount from incorrectly advancing the script.

The targeted reliability checks, ManyChat receipt integration suite, TypeScript, Prisma validation, and production build passed before deployment.

## Evidence from test contact `@tefeo.444`

- ManyChat subscriber: `360134116`.
- Contact is subscribed through `Instagram Follow to DM`.
- The follower automation ran but the physical ManyChat opener was not visible in Instagram. That remains a separate opener-delivery issue.
- A test-only `Convlo - Awaiting first reply` tag was added.
- Two test messages were sent. ManyChat recorded and triggered Default Reply on the first.
- The Default Reply flow configuration is correct on its visible fields: correct endpoint, matching account key, queued-first-reply payload, `$.handoffAccepted` mapping, and a true branch that removes the tag.
- The tag remains and Convlo shows only the earlier outbound context with zero messages.
- Production has no receipt for subscriber `360134116`. Daniel's workspace currently has no queued-handoff receipts and no queued-intake-failure alert. ManyChat reports that its External Request action executed once for this test contact. The request therefore failed before Convlo's deployed queued-receipt path; the exact emitted HTTP body/status is still required before assigning a root cause.
- The published automation shows the condition `Convlo handoff accepted is true` evaluated for one contact, but the success action that removes the test tag ran for zero contacts. Its failure path does nothing. This is a configuration recovery gap: a failed callback is silent and leaves the contact stranded.

## Fresh follow trigger check

A separate, new test account, `@convlo.pipeline.test926`, followed Daetradez specifically to avoid deduplication from the prior test. The follow completed and showed **Following**, but the account had no opener in Inbox or Message Requests. ManyChat's exact-handle search returned no contact, and Convlo's exact-handle search returned no conversation.

This isolates a second problem before Convlo: the live follow-to-DM trigger did not create a ManyChat contact for this fresh account within the observed interval. It cannot be used to test the queued handoff until ManyChat has created the contact and physically delivered the opener.

## Meta read-only findings

- The Daetradez Meta Business Suite home showed both connected surfaces: Facebook (24.9K followers) and Instagram (54.1K followers). No active restriction banner was visible on that page at the time of the read.
- The visible five-item to-do message list was entirely **Messenger**, including the approximately nine-hour-old outbound opener attributed to Daetradez. It is therefore not evidence of an Instagram opener delivery.
- Instagram-specific inbox counts and historical thread ownership remain unproven. They require a read-only Instagram-filtered inbox view or a Meta routing surface that does not alter a lead thread.

## Required next diagnostic

Inspect server-side evidence for the exact callback attempt from subscriber `360134116`:

1. Production request logs for `/api/webhooks/manychat-handoff` at the test time.
2. The matching `ManyChatHandoffReceipt` row, if any.
3. The value of `MANYCHAT_QUEUED_HANDOFF_PAUSED` in production.

This will distinguish paused intake, runtime payload rejection, database failure, and receipt conflict. Do not change the general new-follower flow or replay the test until the response is known.

## Proposed changes (apply none yet)

1. **Repair action order, but do not claim delivery confirmation.** In the live follow flow, put the native Instagram opener action before the Convlo context callback and the first-reply tag. This corrects the present callback-before-opener order. ManyChat alone cannot confirm physical delivery per contact, because the published node exposes aggregate metrics rather than a persisted Meta message ID.
2. **Expose the failed callback response for the test contact.** In ManyChat, open only subscriber `360134116` and capture the External Request response/status for the first direct-message run. This will show whether the problem is a 400 validation error, 401 credential error, 409 receipt conflict, 503 pause, or a database/runtime failure.
3. **Investigate the fresh-follow enrollment failure separately.** A successful Instagram follow that creates neither a ManyChat contact nor a physical opener is upstream of Convlo. Check the live trigger eligibility/event history for the fresh test account without editing, pausing, or republishing the flow.
4. **Add a manual-review failure path after approval.** When `Convlo handoff accepted` stays false, retain the tag but create a clearly named operator-review state rather than silently doing nothing. This must be designed and approved before touching the live flow.
5. **Repair the normal follow handoff in one approved change.** In `Say hi to new followers`, place the native opener before the context callback and add `Convlo - Awaiting first reply` after that opener action. Keep the Default Reply’s existing tag gate and queued callback. This establishes correct handoff order, but does not substitute for a delivery proof. Apply once, review, and test with one new authorized follower; do not make piecemeal live edits.

### Proposed application steps for Tega only

1. In ManyChat, open **Automation** → **Say hi to new followers** → **Edit Automation**.
2. Preserve the existing opener copy and endpoint/key. Reorder the Actions node so the Instagram **Send Message** action precedes the Convlo External Request.
3. Add **Add Tag** → `Convlo - Awaiting first reply` after the opener action.
4. Publish this single reviewed version once. Do not pause, duplicate, or separately republish either live automation.
5. Run one fresh authorized-follower test. Verify the opener in the recipient Inbox or Message Requests, then send the first reply and require a Convlo receipt, one scheduled reply, and a persisted Meta outbound message ID before enabling any broader behavior.

No proposed change has been applied.

## Separate Meta repair

Convlo reports that the Daetradez Page lacks `message_echoes`. Repair that subscription through the Meta reconnect/subscription path and recheck health. This improves outbound delivery evidence; it is not the cause of the failed ManyChat callback.

## Applied changes

None. The live flow, Meta configuration, routing, credentials, production application code, and historical messages were left untouched during both controlled tests.

### Approved configuration repair applied (2026-09-19)

The live `Say hi to new followers` Instagram flow now adds the `Convlo - Awaiting first reply` tag between its existing handoff context request and its Instagram opener. This makes the later inbound reply eligible for `Instagram Default Reply` and the queued first-reply handoff.

This is a configuration-only repair. It does not prove the physical follow opener is delivered, nor does it prove the queued callback produces a receipt. The next clean test must prove opener delivery, receipt creation, scheduling, Meta delivery, and continuation in sequence.

### Fresh post-repair test: trigger still fails before Convlo

`@convlo.pipeline.qa0926` was created as a clean test account and followed Daetradez after the tag repair was published. Instagram confirmed the follow. Its Inbox remained empty; ManyChat had no contact matching the handle; Convlo had no matching lead or handoff receipt.

This rules out the new tag configuration as a fix for the initial failure. The failure happens earlier: Meta/ManyChat is not creating a contact or sending the follow opener for a fresh follower. No further accounts were created because this is the third controlled fresh-follower attempt.

**Required owner:** ManyChat/Meta configuration and support investigation. The next useful evidence is ManyChat's event and delivery log for the exact fresh follower, then Meta's account/event restrictions for the Daetradez Instagram asset. Convlo cannot receive or respond to an event that never arrives.
