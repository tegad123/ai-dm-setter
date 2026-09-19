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

### Production database corroboration

Read-only production queries scoped to subscriber `360134116` found **no** `ManyChatHandoffReceipt`. An aggregate query scoped to Daniel's workspace found **zero receipts of any status** and **zero** `ManyChat first-reply intake failed` notifications.

ManyChat's published flow metrics show that the External Request action ran once for the test contact. Therefore, the callback did not enter the currently deployed queued-receipt path. The remaining unproven boundary is the exact HTTP request emitted by ManyChat. Plausible causes include malformed/non-JSON body, omitted or nonexact `processingMode`, or an upstream request failure. The evidence does not support choosing among them yet.

The published flow also proves that its success branch was not taken: the condition `Convlo handoff accepted is true` was evaluated for one contact, while the following action `Remove Tag Convlo - Awaiting first reply` shows zero contacts. The failure branch is `Do nothing`. This is why the test contact remains stranded with no actionable error visible to an operator.

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

## Live follow-to-DM sequence, observed in the published flow

The published **Say hi to new followers** automation is live. Its visible action order is:

1. `User follows your account` (Instagram Follow to DM trigger).
2. One Actions node containing the Convlo External Request.
3. The same Actions node then performs Instagram `Send Message` with: “Hey there! Thanks for following me are you in the markets rn? or starting?”

The flow has no visible `Add Tag: Convlo - Awaiting first reply` action. The published **Instagram Default Reply** flow requires exactly that tag before it calls the queued first-reply callback.

This establishes two configuration gaps in the normal new-follower path:

- Convlo receives claimed opener context before the native opener action, without independent delivery evidence.
- A fresh follower is not put into the tag gate that enables the Default Reply handoff after their answer.

These are ManyChat configuration findings, not AI engine defects. No change was applied.

### Important limit on the configuration repair

Moving the opener ahead of the callback can guarantee action order, but it cannot prove that Meta delivered the opener. The published ManyChat node reports aggregate send/delivery metrics, not a per-contact persisted Meta message ID that Convlo can validate. Any repair must describe this honestly: action ordering is a configuration correction; physical delivery still requires separate Meta evidence or an integration-level delivery record.

## ManyChat-to-Convlo contract comparison

| Contract item | ManyChat live flow observation | Convlo receiver requirement | Result |
|---|---|---|---|
| Authentication | Account-specific `X-QualifyDMs-Key` header is configured | Header must identify an account | Matches visibly; server acceptance remains unproven |
| Processing mode | `queued_first_reply` | Exact value required for the durable receipt path | Matches |
| Platform | Instagram | `INSTAGRAM` or `FACEBOOK`, defaulting to Instagram | Matches |
| Instagram recipient identity | Contact ID is mapped into `instagramUserId` | Nonempty Instagram recipient ID is required | Mapping exists, but the actual expanded value is unproven |
| Instagram username | Instagram username variable is mapped | Nonempty username is required for Instagram | Mapping exists, but the actual expanded value is unproven |
| Subscriber identity | Contact ID is mapped into `manyChatSubscriberId` | Nonempty subscriber ID is required and becomes the dedupe key | Matches visibly |
| Opener text | Stored opener message is mapped | Nonempty `openerMessage` is required | Matches visibly |
| First lead response | Last Text Input is mapped | Queued mode requires nonempty `leadResponseText` | This is the leading payload-risk: it must contain the first actual reply at run time |
| AI handoff | `scheduleAi: true` | Queued mode requires `scheduleAi: true` | Matches |
| Delivery proof | No native Meta message ID or confirmed-delivery field is sent | Receiver stores opener text, not independent delivery proof | **Mismatch: Convlo can be told an opener exists even when Instagram never displayed it.** |
| Callback success | `$.handoffAccepted` controls tag removal | A durable receipt returns `handoffAccepted: true` | `@tefeo.444` tag remained, so success was not observed |
| Callback failure behavior | Failure branch does nothing | Operator needs a visible failure and safe retry decision | **Mismatch: a failed callback silently leaves the contact tagged without a receipt or recovery signal.** |
| Tag handoff gate | Follow-to-DM flow has no visible Add Tag action | Default Reply calls queued intake only when `Convlo - Awaiting first reply` is present | **Mismatch: ordinary follower replies bypass the first-reply handoff.** |

## Handoff evidence buckets

| Bucket | Records found in this audit | Evidence |
|---|---|---|
| A. Trigger recorded and opener delivery confirmed | None | No persisted Meta message ID was available. |
| B. Trigger recorded, no opener delivery evidence | `@tefeo.444` / subscriber `360134116`, Instagram Follow to DM | Flow trigger was recorded; opener was absent from Inbox and Requests; no Meta ID available. |
| C. Delivery evidence, no lead reply | None | No delivery evidence was available. |
| D. Ambiguous | `@convlo.pipeline.test926` | Follow visibly completed, but no ManyChat contact was created in the observed interval, so there is no trigger record to assess. |

## What remains to identify

The visible result narrows the response to one of these server-side outcomes:

- queued intake is paused;
- the request body is rejected at runtime (for example, an unpopulated variable on this contact);
- durable receipt storage failed; or
- an existing conflicting receipt returned a conflict.

The dashboard does not expose the request response body or receipt table. The next safe diagnostic is to inspect the production request log or the `ManyChatHandoffReceipt` row for subscriber `360134116`. Do not replay this request until that result is known.

## Separate issue: native Instagram webhook health

Convlo also reports that the Daetradez Page is missing the `message_echoes` subscription field. This affects delivery evidence and must be repaired through the Meta subscription/reconnect path, but it does not explain why the ManyChat callback itself failed before receipt creation.

## Fresh follow-to-DM check: `@convlo.pipeline.test926`

To avoid the one-shot Default Reply behavior on `@tefeo.444`, a newly created test-only Instagram account followed `@daetradez` on 2026-09-19. The profile control immediately changed to **Following**, with no visible Instagram challenge or restriction.

After a normal propagation interval:

- The test account's Instagram Inbox was empty.
- Its Message Requests page contained no visible opener.
- A ManyChat Contacts search for the exact handle returned **0 of 0** results.
- A Convlo Conversations search for the exact handle returned **No conversations found**.

This is a second controlled failure, but at an earlier boundary than the `@tefeo.444` test: the fresh follow has not yet created a ManyChat contact. It therefore cannot reach the Default Reply callback or Convlo intake. It is not evidence of an AI, script, webhook, or Meta-send failure.

No live ManyChat automation, Meta routing setting, credential, webhook setting, application code, or historical message was changed for this check.

## Meta Business Suite read-only check

The Daetradez Business Suite home showed Facebook and Instagram connected to the same asset, with 24.9K Facebook followers and 54.1K Instagram followers. Its visible to-do list contained five Messenger threads and no Instagram thread. The approximately nine-hour-old Daetradez opener listed there is a Messenger item, so it does not prove native Instagram delivery. No active restriction banner was visible on the page.

## Boundaries honored

No historical conversation was replayed. No live follow-to-DM flow was edited, paused, reordered, or republished. The only ManyChat data change was the test-only tag on `@tefeo.444`.

## 2026-09-19 Approved ManyChat configuration repair

**Applied live configuration change:** The active Instagram automation **Say hi to new followers** now applies the `Convlo - Awaiting first reply` tag immediately after its existing context External Request to `/api/webhooks/manychat-handoff` and before the special Instagram opening-DM action.

**Purpose:** When the follower subsequently sends a DM, the active **Instagram Default Reply** automation can identify the conversation as a ManyChat first-reply handoff and call Convlo's queued first-reply endpoint.

**Scope:** No application code, Meta routing, credentials, Default Reply request body, response mapping, or historical messages were changed. The existing context callback remains before the opener. ManyChat's special opening-DM step is terminal in this flow builder, so a separate tag action cannot be placed after that send without rebuilding the automation.

**Verification:** The published live flow shows, in order: External Request, Add Tag `Convlo - Awaiting first reply`, Instagram Send Message. The flow is active and saved.

**Still required before declaring recovery:** A genuinely new test follower must receive the physical Instagram opener, reply once, and produce all of: an accepted queued handoff receipt, one scheduled response, one Meta delivery ID, and correct normal continuation. The prior test showed a correctly configured visible Default Reply request but no persisted receipt, so the new end-to-end run remains the deciding proof.
