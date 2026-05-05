# ManyChat completion webhook

When a ManyChat outbound flow ends, fire this webhook so QualifyDMs hands
the conversation off to the AI. Without it the AI will eventually take
over via a 5-minute time-based fallback, but the explicit signal is
faster (~60 s) and clearer in the logs.

## Endpoint

```
POST https://qualifydms.io/api/webhooks/manychat-complete
```

## Headers

```
X-QualifyDMs-Key: <your-account-webhook-key>
Content-Type: application/json
```

The `X-QualifyDMs-Key` value is the same one already configured for the
early `manychat-handoff` webhook — copy it from there.

## Body (JSON)

```json
{
  "instagramUserId": "{{user.id}}",
  "instagramUsername": "{{user.name}}"
}
```

`instagramUsername` is optional but improves matching for legacy leads
whose Instagram numeric ID was never captured. `instagramUserId` is
required.

## Where to add it in the ManyChat flow

Place this as the **final action** in the outbound sequence — _after_
the Smart Delay + Condition steps, as the very last node before the
flow exits. That's the moment the AI should take over.

Example sequence order:

1. Opener DM with "Yes, send it over!" button (existing)
2. Lead taps button → fires the `manychat-handoff` External Request
   (existing)
3. Send "Perfect, this is gonna make you dangerous on the markets 🔥"
   + video link (existing)
4. Add tag `link_clicked` (existing)
5. Smart Delay — 30 minutes (existing)
6. Condition: tag not clicked → send follow-up (existing)
7. **NEW: External Request → `POST /api/webhooks/manychat-complete`** —
   final action, fires once the sequence concludes.

## Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "success": true, "conversationId": "...", "alreadyHandedOff": false }` | Handoff applied — AI will pick up within ~60 s |
| `200` | `{ "success": true, "conversationId": "...", "alreadyHandedOff": true }` | Already handed off (idempotent re-fire) |
| `404` | `{ "error": "lead_not_found" }` | No matching Instagram lead found — check `instagramUserId` mapping in the ManyChat External Request |
| `400` | `{ "error": "Invalid ManyChat payload" }` | Body shape is wrong (missing `instagramUserId`?) |
| `401` | `{ "error": "Missing X-QualifyDMs-Key" }` or `"Invalid webhook key"` | Header is missing or wrong key |

## What the endpoint does

1. Looks up the Lead by `accountId + platform=INSTAGRAM +
   (platformUserId OR handle)` — same lookup the handoff endpoint uses.
2. Sets on the Conversation:
   - `aiActive = true`
   - `awaitingAiResponse = true`
   - `awaitingSince = now()`
3. The silent-stop heartbeat (cron, every 1 minute) picks up the row
   on its next tick and the AI fires its first reply.

The endpoint does NOT generate the AI reply itself — that goes through
the standard recovery flow so the discovery-question bridge
(`buildManyChatOpeningRecovery`) fires correctly.

## What if you forget to add it

The time-based fallback in `silentStopHeartbeat` covers this case:
once a `source=MANYCHAT` conversation has a LEAD message that's been
unanswered for >5 minutes, the heartbeat flips the same flags and the
AI takes over. So the webhook is "fast path"; the fallback is "safety
net." Adding the webhook gives ~5× faster handoff and cleaner ops
logs.

## Related — capture each ManyChat-sent message

To make every ManyChat-sent DM appear in the QualifyDMs dashboard
(opener follow-up, video links, sequence reminders), see
[`manychat-message-webhook.md`](./manychat-message-webhook.md). Fire
that webhook right after every "Send Message" node in your flow.
