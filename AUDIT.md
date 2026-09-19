# ManyChat follow-to-DM evidence audit — 2026-09-19

## Step 0 outcome: AMBIGUOUS

`@tefeo.444` is following `@daetradez`. Its Instagram inbox and Message Requests were empty when checked. A ManyChat contact search for `tefeo.444` returned no contact. Therefore there is no per-contact ManyChat run, send record, delivery error, callback, Convlo handoff, receipt, or Meta message ID to inspect.

This is not a Convlo send failure. The missing fact is whether Instagram emitted an eligible follow event to ManyChat. A per-contact ManyChat flow record or a native opener would resolve it. A new account follow alone does not.

## Live flow comparison

| Stage | Published ManyChat flow | Convlo behavior | Gap / evidence standard |
|---|---|---|---|
| New follower trigger | `User follows your account` | No input until ManyChat calls it | Fresh accounts can fail before a ManyChat contact is created. |
| Context callback | Calls `/api/webhooks/manychat-handoff` with `scheduleAi:false` before the special Opening DM | Records context only | Correctly cannot prove the opener was sent. |
| Opening DM | Special Instagram Opening DM runs after the callback | No post-send callback is available | A native Meta echo or visible inbox message is required for proof. |
| First lead reply | Instagram Default Reply checks `Convlo - Awaiting first reply` | Queued mode accepts one durable receipt only on the true branch | The live new-follower flow does not apply this tag, so ordinary follower answers bypass Convlo. |
| AI delivery | Existing scheduler and Meta sender | Requires persisted Meta message ID | An HTTP 200 or a ManyChat aggregate “sent” value is not delivery proof. |

## Current evidence buckets

| Bucket | Result |
|---|---|
| A. Trigger and opener delivery confirmed | No fresh `tefeo.444` example. |
| B. Trigger recorded, no opener delivery proof | `@squirrel.8425393`, previously documented. ManyChat flow evidence existed but no opener was visible in either Instagram thread. |
| C. Delivery evidence, no lead reply | No newly verified `tefeo.444` example. |
| D. Ambiguous | `@tefeo.444`: follow is present but no ManyChat contact or opener. |

## Controlled callback test path

A direct message from `@tefeo.444` alone is not a valid queued-first-reply test: the Default Reply flow’s false tag branch does nothing. A valid test requires:

1. Open the test contact’s 24-hour Meta window with one test-only inbound message.
2. Add `Convlo - Awaiting first reply` to that single test contact in ManyChat.
3. Send the next test-only reply.
4. Verify one `ManyChatHandoffReceipt`, one scheduled reply, one persisted Meta message ID, and correct continuation.

No live flow, tag, credential, routing rule, permission, or historical conversation was changed while creating this audit.
