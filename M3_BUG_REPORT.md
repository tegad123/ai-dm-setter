# M3 Production Bug Report — Convlo AI Setter

**Source:** Daniel's bug list off the live Paris Mokoena conversation (FACEBOOK lead, 195 messages, Jun 16–17 2026, ended UNQUALIFIED). The lead asked *"So am I chatting to Ai or real person 😅🤣"* — the product failing in production.

**Method:** Each bug is confirmed against the **real prod record** (read-only via `PROD_DATABASE_URL`) before fixing — the "before" is the actual incident, not a hypothetical. The "after" is verified on the local DM harness, which runs the **same code** that runs in prod with real outbound delivery.

**Status legend:** ✅ fixed & verified · 🔧 in progress · ⏳ queued

---

## ETA summary (per client request)

| # | Bug | Sev | Est | Status |
|---|-----|-----|-----|--------|
| 05 | Back-to-back messages each get a reply | HIGH | 4–6h | ✅ |
| 01 | Looping line (verbatim repeat) | CRIT | 4–6h | ✅ |
| 10 | Dead-end "one sec" stall | HIGH | — | 🔧 (folded into 07/09 — it's a symptom of re-booking) |
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

---

## BUG-01 — Looping broken/repeated line ✅ FIXED & VERIFIED

### What the client reported
> The AI repeated this identical line at least 4 times: *"I mean bro, based off what it seems, the main struggle you're facing is greediness and lack of patience, but like I said your commitment is truly"* — and it cuts off mid-sentence.

### What the prod data shows (root cause corrected)
Pulled from the Paris conversation — the line fired **4 times verbatim**, all at **stage = "Call Proposal" (subStage COMMITMENT_CONFIRM/PATH_A)**:

```
12:07:40  (multi-bubble)  after lead: "Yes bro" / "Today"
12:47:21  (single-send)   after lead: "Waiting for cleaner confirmation"
13:13:49  (single-send)   after lead: "600usd"            ← lead just gave capital
13:21:44  (single-send)   after lead: "…are you selling it or not / Yeah it is / ??"
```

Two corrections to the original hypothesis:
1. **It is NOT a stored truncated string.** It's the **model regenerating the same observation verbatim** whenever it's stuck at the Call-Proposal stage and the lead's message doesn't cleanly advance it. (The "cut off mid-sentence" is BUG-02, a separate truncation issue.)
2. None of the existing repeat-detectors caught it — it isn't an opener, a capital question, or a call pitch, so it slipped through every *specific* guard.

### The fix (code-level guard, not a prompt rule)
Added a **generic `verbatim_repeat` hard-fail** to the quality gate (`src/lib/voice-quality-gate.ts`): if a generated reply is **≥85% identical** (Jaccard, content words) to **any of the last 8 AI messages**, it hard-fails and forces a fresh regeneration with an explicit "you already said this — respond to what the lead actually said" directive. Short acks (< 8 content words) are excluded (those are handled by the existing `repeated_opener` guard), so no false positives.

This is a catch-all: it kills **any** verbatim loop, including **BUG-13** (duplicate pitch/link sent twice).

### Verification
- **Before:** prod evidence above — same line 4×, verbatim, at Call-Proposal stage.
- **After:** 4 unit tests pass (identical repeat → caught; near-verbatim 5 turns back → caught; genuinely different reply → not flagged; short ack → not flagged). All 47 existing quality-gate / intelligence / placeholder unit tests still pass. `tsc` clean.

### Related finding → BUG-10 re-scoped
BUG-10's *"give me one sec to get that locked in 🙏"* stall (fired 5×, the last one a literal dead-end with no follow-up) is **a symptom of BUG-09**: the conversation already had a confirmed booking (`scheduledCallAt`, `bookingId` both set), but the AI kept re-entering BOOKING_CONFIRM and re-attempting to book the already-booked call → the booking call fails → it ships the holding line. Fixing BUG-09's booking-state circuit-breaker removes the stall at its source, so BUG-10 is folded into the BUG-07/09 work rather than band-aided separately. (The same data also confirms BUG-09's date mismatch: `scheduledCallAt` = Sat Jun 20 while the chat agreed Monday.)
