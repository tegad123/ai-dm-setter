# Live Facebook and Instagram E2E plan

Date: 2026-09-23. This plan is paired with `docs/launch-tracker.json`.

## Start condition

Shazim sends a real message from his Facebook and Instagram accounts to
Daniel's connected accounts, then shares the sender handles and approximate UTC
send times. A real lead message opens the platform's 24-hour standard messaging
window. The existing chats can prove continuation, but they do not prove a
brand-new lead path. A fresh account or a separately agreed isolated test is
needed for that acceptance case.

Do not inject a synthetic webhook for the same real message. It would create a
second inbound event that did not exist in Meta and could prompt a duplicate
reply. Do not clear or reset a live conversation to make it look new.

## Before the messages

1. Record production `/api/version`, active script ID/version, account settings
   for each platform, and current conversation IDs and latest message IDs.
2. Start Vercel log capture for the actual project and run read-only pipeline
   health checks. Confirm there is no stalled cron or widespread delivery issue.
3. Record whether Instagram is entering through ManyChat or direct Meta
   webhooks, and whether the opener was visibly delivered. Do not infer an
   opener from a planned automation or tag alone.

## Turn-by-turn proof

For each platform, after each real inbound:

1. Confirm the native inbound ID appears once in the right account and
   conversation. Record lead, conversation and any handoff receipt IDs.
2. Record the job ID, claim snapshot, active script step/branch, generation
   trace ID, planned message parts and egress decision.
3. Wait for the normal inline worker or cron. Confirm one logical reply with
   the intended parts, persisted outbound Meta message ID, and no duplicate
   bubble or script reset.
4. Read the actual reply in Facebook/Instagram, then choose the next lead
   message based on the active script and observed state. Continue until the
   relevant branch, link, hold or handoff is reached.
5. Repeat for a continuing conversation. Save before/after state and report
   any mismatch immediately instead of advancing the conversation blindly.

Read-only commands from the repo root:

```bash
curl -fsS https://qualifydms.io/api/version
NODE_PATH=$PWD/node_modules npx tsx scripts/verify/reply-pipeline-health.ts
NODE_PATH=$PWD/node_modules npx tsx scripts/verify/watch-conversation.ts <conversationId>
NODE_PATH=$PWD/node_modules npx tsx scripts/verify/scheduled-reply-terminal-outcomes.ts
```

The older `drive-prod-funnel.ts` and `ig-inbound-proof.ts` default to synthetic
senders or generate signed webhook events. They are useful for isolated routing
tests, but they do not prove Meta delivery to Shazim's real accounts. Use the
natural real DMs for delivery evidence first. A separate signed-webhook test
must use a distinct event ID and a documented purpose.

## Acceptance records

Record for each case: platform and native inbound ID; script ID/version; release
commit; sender and conversation ID; handoff receipt when relevant; queue and
generation trace IDs; prior/current step and branch; expected and actual
reply; outbound Meta IDs; send/review/terminal reason; screenshots or a read
of the platform inbox; owner and Tega's sign-off.

The first live FB/IG chats are a smoke and continuation test. They do not, by
themselves, close all twelve P0 items or the ManyChat callback/native race
matrix. Keep the six preserved human-review conversations unchanged.
