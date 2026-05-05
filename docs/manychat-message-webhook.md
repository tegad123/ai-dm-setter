# ManyChat message webhook

Fire this webhook from your ManyChat flow **right after every "Send
Message" action** so each automated DM appears in the QualifyDMs
dashboard. Without it, ManyChat-sent DMs (the opener follow-up like
"Perfect, this is gonna make you dangerous on the markets 🔥 + video
link", and any later sequence steps) won't appear in the conversation
view.

## Why this is needed

Meta's Instagram messaging webhook isn't currently firing echo events
for this account, so we don't see ManyChat-sent DMs through the
standard delivery path. This endpoint lets ManyChat tell us about each
sent message directly, bypassing the broken Meta echo path.

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
  "instagramUserId": "{{user.id}}",
  "instagramUsername": "{{user.name}}",
  "messageText": "Perfect, this is gonna make you dangerous on the markets 🔥 https://youtu.be/...",
  "manyChatMessageId": "{{message_id}}"
}
```

| Field | Required | Notes |
|---|---|---|
| `instagramUserId` | yes | `{{user.id}}` — IG numeric ID |
| `instagramUsername` | no | `{{user.name}}` — improves matching for legacy leads stored by handle |
| `messageText` | yes | The exact text ManyChat sent. Up to 4000 chars. |
| `sentAt` | no | ISO-8601 timestamp. Defaults to server time when ManyChat doesn't expose one. |
| `manyChatMessageId` | no | If your flow can emit it, we use it as a deterministic dedup key. Otherwise we fall back to content + timestamp dedup within a 5-minute window. |

## Where to add it in the ManyChat flow

After **every** "Send Message" node in the outbound automation:

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

## Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "success": true, "conversationId": "...", "messageId": "...", "duplicate": false }` | Message stored as `sender=MANYCHAT` |
| `200` | `{ "success": true, "conversationId": "...", "messageId": "...", "duplicate": true }` | Same `manyChatMessageId` (or content within 5 min) already stored — idempotent re-fire |
| `404` | `{ "error": "lead_not_found" }` | No matching IG lead — check `instagramUserId` mapping |
| `400` | `{ "error": "Invalid ManyChat payload" }` | Body shape wrong (missing `instagramUserId` / `messageText`?) |
| `401` | `{ "error": "Missing X-QualifyDMs-Key" }` or `"Invalid webhook key"` | Header missing or wrong |

## Visual treatment

Messages stored via this endpoint appear in the dashboard with a
violet/indigo "ManyChat · automation" label, distinct from the AI
Setter (blue) and Human Setter (emerald) treatments.
