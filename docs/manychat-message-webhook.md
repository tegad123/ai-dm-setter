# ManyChat message webhook

When a ManyChat flow supports a next action after a "Send Message" node, fire
this webhook from that next action so each automated DM appears in Convlo with
a **provider-reported** status. Without it, ManyChat-sent DMs (the opener follow-up like
"Perfect, this is gonna make you dangerous on the markets 🔥 + video
link", and any later sequence steps) won't appear in the conversation
view.

## Why this is needed

This endpoint records ManyChat's report. It is not independent proof that Meta
delivered the message. A later native Meta echo supplies the Meta message ID and
upgrades the same row to `META_CONFIRMED`.

(Separate action: investigate the Instagram webhook subscription in
the Meta App settings — re-subscribe to messaging events with the
production webhook URL. Once Meta echoes are flowing again, this
endpoint stays useful as a faster, lossless alternative.)

## Endpoint

```
POST https://qualifydms.io/api/webhooks/manychat-message
```

## Headers

```
X-QualifyDMs-Key: <your-account-webhook-key>
Content-Type: application/json
```

Same key as the existing `manychat-handoff` and `manychat-complete`
endpoints.

## Body (JSON)

```json
{
  "platform": "instagram",
  "instagramUserId": "{{user.id}}",
  "instagramUsername": "{{user.name}}",
  "messageText": "Perfect, this is gonna make you dangerous on the markets 🔥 https://youtu.be/...",
  "manyChatMessageId": "{{message_id}}"
}
```

| Field               | Required | Notes                                                                                                                                                                                                   |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`          | no       | `instagram` by default; send `facebook` for Messenger.                                                                                                                                                  |
| `instagramUserId`   | yes      | `{{user.id}}` — IG numeric ID                                                                                                                                                                           |
| `instagramUsername` | no       | `{{user.name}}` — improves matching for legacy leads stored by handle                                                                                                                                   |
| `messageText`       | yes      | The exact text ManyChat sent. Up to 4000 chars.                                                                                                                                                         |
| `sentAt`            | no       | ISO-8601 timestamp. Defaults to server time. Supplied values may be at most 5 minutes in the future or 24 hours old; values outside that range are rejected before matching, ordering, or cancellation. |
| `manyChatMessageId` | no       | If your flow can emit it, we use it as a deterministic dedup key. Otherwise we fall back to content + timestamp dedup within a 5-minute window.                                                         |

For Facebook, use:

```json
{
  "platform": "facebook",
  "facebookUserId": "<Page-scoped contact ID>",
  "manyChatSubscriberId": "{{contact.id}}",
  "contactName": "{{contact.name}}",
  "messageText": "Exact text ManyChat sent",
  "manyChatMessageId": "<stable provider operation id, when available>"
}
```

## Where to add it in the ManyChat flow

After every ordinary "Send Message" node that exposes a next action:

1. Send opener (existing) → fire `manychat-handoff` (existing)
2. Lead taps button (existing)
3. Send "Perfect, this is gonna make you dangerous 🔥 + video link"
   → **NEW: fire `/api/webhooks/manychat-message` with the message
   text**
4. Add tag `link_clicked` (existing)
5. Smart Delay 30 min (existing)
6. Condition: not clicked → send follow-up message
   → **NEW: fire `/api/webhooks/manychat-message` for the follow-up
   text**
7. Final action: fire `/api/webhooks/manychat-complete` (per
   `docs/manychat-complete-webhook.md`)

The special Instagram Follow-to-DM Opening DM currently has the Convlo action
before the opener and no ordinary immediate post-send next action in the
published graph. Keep that early callback as context-only. It must not create a
sent bubble. A native Meta echo can confirm the opener later, and the lead's
real first response can continue the AI handoff without a visible opener row.

## Responses

| Status | Body                                                                                   | Meaning                                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | `{ "success": true, "conversationId": "...", "messageId": "...", "duplicate": false }` | Provider report stored as `sender=MANYCHAT`; Meta delivery remains unconfirmed until a native echo supplies a Meta ID.                                                                                                  |
| `200`  | `{ "success": true, "conversationId": "...", "messageId": "...", "duplicate": true }`  | Same `manyChatMessageId` (or content within 5 min) already stored — idempotent re-fire                                                                                                                                  |
| `409`  | `{ "error": "contact_identity_conflict" }`                                             | More than one lead matches the supplied identity; no message is changed.                                                                                                                                                |
| `409`  | `{ "error": "echo_attribution_already_finalized" }`                                    | The matching native echo was already finalized as a human message. Convlo creates one deduplicated operator notification with conversation, message, and provider-operation context; retries do not create more alerts. |
| `404`  | `{ "error": "lead_not_found" }`                                                        | No matching IG lead — check `instagramUserId` mapping                                                                                                                                                                   |
| `400`  | `{ "error": "sent_at_out_of_range" }`                                                  | `sentAt` is more than 5 minutes ahead of Convlo or more than 24 hours old. Nothing is matched, reordered, or cancelled.                                                                                                 |
| `400`  | `{ "error": "Invalid ManyChat payload" }`                                              | Body shape wrong (missing `instagramUserId` / `messageText`?)                                                                                                                                                           |
| `401`  | `{ "error": "Missing X-QualifyDMs-Key" }` or `"Invalid webhook key"`                   | Header missing or wrong                                                                                                                                                                                                 |

## Visual treatment

Messages stored via this endpoint appear with an amber, dashed
`Reported by ManyChat · awaiting Meta confirmation` treatment. A native Meta
echo upgrades the same row to `Meta confirmed`. Planned context is hidden from
sent history, and failed delivery evidence appears as a red audit event.
