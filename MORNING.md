# Morning packet — 2026-09-19

## Current status

The ManyChat first-reply integration is **not yet recovered for general traffic**. A controlled test now isolates the failure precisely:

- Instagram accepts the test account's DM.
- ManyChat receives it and triggers `Instagram Default Reply`.
- The tagged action path calls the configured Convlo handoff endpoint.
- Convlo records no new message or AI work, and the tag is not removed.

That means the failure is at the callback response or durable receipt intake boundary, before the AI engine, script routing, or Meta delivery.

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

## Fresh follow trigger check

A separate, new test account, `@convlo.pipeline.test926`, followed Daetradez specifically to avoid deduplication from the prior test. The follow completed and showed **Following**, but the account had no opener in Inbox or Message Requests. ManyChat's exact-handle search returned no contact, and Convlo's exact-handle search returned no conversation.

This isolates a second problem before Convlo: the live follow-to-DM trigger did not create a ManyChat contact for this fresh account within the observed interval. It cannot be used to test the queued handoff until ManyChat has created the contact and physically delivered the opener.

## Required next diagnostic

Inspect server-side evidence for the exact callback attempt from subscriber `360134116`:

1. Production request logs for `/api/webhooks/manychat-handoff` at the test time.
2. The matching `ManyChatHandoffReceipt` row, if any.
3. The value of `MANYCHAT_QUEUED_HANDOFF_PAUSED` in production.

This will distinguish paused intake, runtime payload rejection, database failure, and receipt conflict. Do not change the general new-follower flow or replay the test until the response is known.

## Separate Meta repair

Convlo reports that the Daetradez Page lacks `message_echoes`. Repair that subscription through the Meta reconnect/subscription path and recheck health. This improves outbound delivery evidence; it is not the cause of the failed ManyChat callback.

## Applied changes

None. The live flow, Meta configuration, routing, credentials, production application code, and historical messages were left untouched during both controlled tests.
