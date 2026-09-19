# ManyChat controlled first-reply evidence audit — 2026-09-19

## Result: callback failure isolated before Convlo intake

The controlled test used the user-owned Instagram account `@tefeo.444` only. It now has conclusive evidence at each visible boundary:

1. **ManyChat created the contact**: subscriber `360134116`, named `jerrry woo`, is subscribed and shows `Opted In through Instagram Follow to DM`.
2. **The follower automation ran** at 02:49. The test account did not receive a native opener in Instagram, so physical opener delivery remains an independent unresolved issue.
3. The test-only tag `Convlo - Awaiting first reply` was applied to that contact.
4. Two direct messages were accepted by Instagram at 10:14: `Hi, I’m testing the automated reply.` and `I’m new to trading and looking to get started.`
5. **ManyChat received the first message and triggered `Instagram Default Reply`**. The contact activity log records the trigger, and the flow analytics record that the tagged condition reached its action path.
6. The published action is configured to POST `processingMode: queued_first_reply`, `platform: instagram`, the subscriber/contact identifiers, the stored opener, `scheduleAi: true`, and `{Last Text Input}` to Convlo. Its response mapping is `$.handoffAccepted`, and its true branch removes the tag.
7. The tag remains on the contact. Therefore the callback did not return `handoffAccepted: true`.
8. **Convlo has the original outbound context record for `@tefeo.444`, but it still has 0 messages and 0 AI messages.** It has not received a durable first-reply handoff or either native inbound message.

This proves the current failure is not a script-selection, AI-generation, or Meta-send failure. The handoff request returns a non-success outcome before Convlo creates a durable receipt.

## Confirmed configuration facts

| Item | Observed state |
|---|---|
| Default Reply trigger | Live and triggered for `@tefeo.444` |
| Tag gate | Matched; action path ran |
| Handoff URL | Correct Convlo handoff endpoint |
| Account webhook credential | Matches the key currently displayed in Convlo Integrations |
| Request mode | `queued_first_reply` |
| Response mapping | `$.handoffAccepted` to the boolean `Convlo handoff accepted` field |
| Success action | Removes `Convlo - Awaiting first reply` |
| Convlo conversation | Existing ManyChat context only; zero messages |

## What remains to identify

The visible result narrows the response to one of these server-side outcomes:

- queued intake is paused;
- the request body is rejected at runtime (for example, an unpopulated variable on this contact);
- durable receipt storage failed; or
- an existing conflicting receipt returned a conflict.

The dashboard does not expose the request response body or receipt table. The next safe diagnostic is to inspect the production request log or the `ManyChatHandoffReceipt` row for subscriber `360134116`. Do not replay this request until that result is known.

## Separate issue: native Instagram webhook health

Convlo also reports that the Daetradez Page is missing the `message_echoes` subscription field. This affects delivery evidence and must be repaired through the Meta subscription/reconnect path, but it does not explain why the ManyChat callback itself failed before receipt creation.

## Boundaries honored

No historical conversation was replayed. No live follow-to-DM flow was edited, paused, reordered, or republished. The only ManyChat data change was the test-only tag on `@tefeo.444`.
