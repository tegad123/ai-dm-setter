# scripts/verify — prod verification tools (Sept 2026)

These are the scripts that produced the evidence for the Instagram inbound fix,
the outbound-outage fix, IG parity day 1, and generate-only mode. They were
scratch files during the work; they are tracked here so the next engineer (or
AI tool) can re-run every proof without rediscovering anything.

All read `PROD_DATABASE_URL` and `META_APP_SECRET` from `.env`. None print a
token. Run from the repo root:

```
NODE_PATH=$PWD/node_modules npx tsx scripts/verify/<script>.ts [args]
```

`generate-only-proof.ts enforce` and anything that imports `src/lib/*`
(which use the `@/lib/prisma` singleton) must ALSO be launched with
`DATABASE_URL="$PROD_DATABASE_URL"` in the shell — ES imports are hoisted, so
setting `process.env.DATABASE_URL` inside a script does nothing.

| script | what it proves | typical use |
|---|---|---|
| `reply-pipeline-health.ts` | the outbound reply pipeline is alive: PROCESSING backlog, overdue rows, last SENT, last AI message, stuck `awaitingAiResponse` | first thing to run when "no reply came" |
| `ig-credential-health.ts` | for every INSTAGRAM credential: stored ids vs the id Meta will deliver in `entry.id` (live `/me?fields=user_id`), subscription state, token validity; plus OpenAI / Meta page token health for one account | Instagram DM "doesn't exist anywhere" |
| `ig-inbound-proof.ts` | a Meta-shaped, HMAC-signed Instagram webhook with a given `entry.id` resolves into the expected workspace (lead + conversation + message) | after any change to `webhooks/instagram/route.ts` or the connect callback |
| `watch-conversation.ts` | full chain for a conversation or the newest lead: messages (delivered?), ScheduledReply status/errors, generation traces, egress shadow rows | reading evidence for Tega |
| `not-connected-proof.ts` | an IG webhook for a workspace with a META credential but no INSTAGRAM one raises the operator notification and creates no lead | IG parity day-1 alert |
| `generate-only-proof.ts` | generate-only mode end to end on a workspace: AI on, suggestion stored, queue row closed `suggestion_only`, shadow row `generate_only`, zero deliveries, and a direct non-operator send blocked `GENERATE_ONLY` | before flipping generate-only on a client |

Synthetic senders use 16-digit ids starting `9900…` so they are easy to find
and delete; every proof has a `--cleanup` / `restore` step. Delivery to a
synthetic sender can never succeed at Meta — resolution + generation are the
proof; delivery proof needs a real sender (a real DM from a real account).
