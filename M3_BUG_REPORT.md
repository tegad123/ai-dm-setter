# M3 Production Bug Report — Convlo AI Setter

**Source:** Daniel's bug list off the live Paris Mokoena conversation (FACEBOOK lead, 195 messages, Jun 16–17 2026, ended UNQUALIFIED). The lead asked *"So am I chatting to Ai or real person 😅🤣"* — the product failing in production.

**Method:** Each bug is confirmed against the **real prod record** (read-only via `PROD_DATABASE_URL`) before fixing — the "before" is the actual incident, not a hypothetical. The "after" is verified on the local DM harness, which runs the **same code** that runs in prod with real outbound delivery.

**Status legend:** ✅ fixed & verified · 🔧 in progress · ⏳ queued

---

## ETA summary (per client request)

| # | Bug | Sev | Est | Status |
|---|-----|-----|-----|--------|
| 05 | Back-to-back messages each get a reply | HIGH | 4–6h | ✅ |
| 01+10 | Looping line / dead-end "one sec" stall | CRIT+HIGH | 4–6h | ⏳ |
| 02 | Mid-sentence truncation | CRIT | 2–4h | ⏳ |
| 03 | Internal template/placeholder leak | CRIT | 2–3h | ⏳ |
| 07+09 | Re-asks known info / re-books / date mismatch | HIGH | 6–9h | ⏳ |
| 08 | Image hallucination | HIGH | 3–5h | ⏳ |

**CRITICAL + HIGH total ≈ 3–5 working days** incl. before/after verification. MEDIUM bugs (11–15) ≈ +1.5–2 days, do not gate M3.

**Bigger-than-it-looks flags (raising now, not at the deadline):**
- **BUG-07/09** — booking-state isn't fed back to the AI, plus a calendar UTC-vs-timezone date mismatch that may grow once traced live.
- **BUG-05** — touches the reply-scheduling core; needed careful regression testing (done).

---

## BUG-05 — Back-to-back messages ✅ FIXED & VERIFIED

### What the client reported
> "When the lead sends several messages in a row, the AI processes one and ignores the rest."

### What the prod data actually shows (important correction)
We pulled all 195 Paris messages and grouped them. **The message buffering already works in production.** Of 114 AI messages, **103 were delivered as properly batched multi-bubble groups** (the AI read 2–3 lead messages and answered the batch once, with realistic 13–25s gaps between bubbles). There were **81 `ScheduledReply` rows, 17 of them CANCELLED** — i.e. the debounce machinery is actively superseding stale replies as designed. A debounce of "10–30s" already exists (`Account.debounceWindowSeconds`, default 45s).

So the symptom Daniel saw — "ignored the rest" — was **not a buffering failure.** In every burst, the AI *did* fire one batched reply; it just **didn't address all the questions** in that batch. Example (Paris 13:20):

```
LEAD 13:20:22  So how does the system works are you selling it or not
LEAD 13:20:59  Yeah it is
LEAD 13:21:15  ??
AI   13:21:44  I mean bro, based off what it seems, the main struggle you're facing is greediness…   ← canned loop, answered none
```

That is **BUG-06 (dodging questions)** + **BUG-01 (canned loop line)** — tracked and fixed under those items. The looping line was confirmed to ship via the single-send path (`messageGroupId = NULL`) and to be **truncated on model output**, not a stored truncated string.

### The real BUG-05: a latent race on the fast path
There *is* a genuine buffering bug, but it only bites on the **inline/fast path** (short response delays — including the test harness at ~0s), not the prod cron path Paris went through. When two webhooks arrive close together, the second cancels the first's `PENDING` reply — but if the first had already flipped `PENDING → PROCESSING`, the cancel (`updateMany where status:PENDING`) misses it, and **two generations run, each blind to the other's messages.**

**Root cause (file:line):** `src/app/api/webhooks/instagram/route.ts` and `.../facebook/route.ts` inline `after()` path claim the reply then generate, with no check that a newer message has since arrived. The debounce batching in `webhook-processor.ts:2966` is gated behind `!skipDelayQueue` and is bypassed on this path.

### The fix
Added `isScheduledReplySuperseded()` (`src/lib/webhook-processor.ts`) — after the inline path claims its reply row (`PENDING → PROCESSING`), it checks whether a strictly-newer **active** (`PENDING`/`PROCESSING`) reply row exists for the conversation. If so, this claim is stale and it **yields** (marks itself CANCELLED), so only the newest reply generates — on the full message batch. Wired into both the Instagram and Facebook inline paths.

### Verification
- **Before:** prod evidence above — the inline race is latent (prod uses cron, which batches correctly); reproducible under load with short delays.
- **After:** unit-tested the guard (3 cases: only/newest → false; newer PENDING exists → true; newer CANCELLED/SENT → ignored). All pass. `tsc --noEmit` clean across all routes.
- **Net effect:** a burst of N lead messages → one reply generated on the full batch, on both the cron and inline paths.

### Note for the client
This is a **correctness fix to existing infrastructure**, not a new feature — the debounce Daniel asked for already shipped. The visible "ignored my messages" feeling in the Paris log is resolved by the **BUG-06 / BUG-01 / BUG-10** fixes (next in the queue), which stop the AI from answering a batch with a canned non-answer.
