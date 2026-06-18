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
| 10 | Dead-end "one sec" stall | HIGH | — | ✅ (fixed with 07/09 — circuit-breaker + operator escalation) |
| 02 | Mid-sentence truncation | CRIT | 2–4h | ✅ |
| 03 | Internal template/placeholder leak | CRIT | 2–3h | ✅ |
| 07+09 | Re-asks known info / re-books / date mismatch | HIGH | 6–9h | ✅ (prod "after" run pending) |
| 08 | Image hallucination | HIGH | 3–5h | ✅ |

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

---

## BUG-02 — Mid-sentence truncation ✅ FIXED & VERIFIED

### What the client reported
> Messages cut off mid-word, including the actual offer pitch: *"It's about 6 to 10 hours of vid"* — the single most important message in the funnel.

### What the prod data shows (root cause confirmed)
Pulled the exact pitch message from the Paris conversation:

```
15:25:07  bubble 1/2  len=126:  "I have a self-paced course that covers my entire Session
                                  Liquidity Model from start to finish. It's about 6 to 10 hours of vid"
```

Key evidence: it's **bubble 1 of a 2-bubble group**, only **126 chars** (far under the 450-char soft limit), cut mid-word at "vid[eo]". So it's not a character cap and not the whole response being dropped — the model's **output-token ceiling (`max_tokens: 1500`) was exhausted mid-emission**, cutting the JSON string. The generation code read `response.content` but **never checked `stop_reason`**, so a truncated response shipped as-is.

### The fix
1. **Raised `max_tokens` 1500 → 2048** on both the Anthropic and OpenAI-fallback paths (`src/lib/ai-engine.ts`) — headroom for verbose multi-bubble pitches.
2. **Added a completion guard:** `callLLM` now returns `truncated: true` when Anthropic `stop_reason === 'max_tokens'` (or OpenAI `finish_reason === 'length'`). The main generation loop **regenerates** instead of shipping a fragment (falls through only on the final retry, where a complete-enough reply beats none).

### Verification
- **Before:** prod evidence above — pitch bubble cut at "...vid", `stop_reason` never inspected.
- **After:** SDK field names confirmed (`stop_reason='max_tokens'`, `finish_reason='length'`); guard wired into the retry loop; `tsc` clean; 32 unit tests pass. Final confirmation on the live prod "after" run — drive to the offer pitch and confirm it delivers complete.

---

## BUG-03 — Internal template/placeholder leak ✅ FIXED & VERIFIED

### What the client reported
> At 9:55 the AI exposed raw internal instruction text: *"Appreciate that bro, just missing your specific missing info e.g. "email" / "timezone" / "phone number"."* — reads as a glitchy form error, instant "this is a bot" signal.

### What the prod data shows (confirmed verbatim)
Found the exact leak in the Paris conversation (14:54:58):

```
"Appreciate that bro, just missing your specific missing info e.g. "email" / "timezone" / "phone number"."
```

The system already has a fail-closed ship-time guard (`detectMetadataLeak` → block send + escalate, `webhook-processor.ts:4499`) and a regen guard in the quality gate. But its `METADATA_LEAK_PATTERNS` only matched `field:value` signatures, brackets, `{{}}`, and JSON — **not** a quoted-field *list* (`e.g. "email" / "timezone" / …`). So this particular scaffolding shape slipped past both.

### The fix (code-level hard guard, per client)
Added three patterns to `METADATA_LEAK_PATTERNS` (`src/lib/voice-quality-gate.ts`):
1. the `missing … missing info` scaffolding phrase,
2. `e.g. "x" / "y"` quoted lists,
3. slash-joined quoted slot-name pairs (email/timezone/phone number/full name/…).

Because both the **regen guard** and the **fail-closed ship-time guard** call `detectMetadataLeak`, this leak now (a) forces a regeneration, and (b) if it somehow survives, is **blocked before delivery** and escalated to a human — it can never reach the lead. This is a guard, not a prompt rule, so it catches the leak regardless of which prompt produced it.

### Verification
- **Before:** exact leak in prod (above); not matched by any existing pattern.
- **After:** 8 new unit tests (4 leak variants caught, 4 natural slot-asks like "what's your email?" / "what timezone are you in?" correctly allowed — no false positives). 48 related unit tests pass. `tsc` clean.

---

## BUG-07 + BUG-09 + BUG-10 — Slot memory, re-booking, date mismatch, dead-end stall ✅ FIXED (prod "after" pending)

### What the client reported
- **BUG-07:** AI re-asked budget after the lead said "600usd", re-asked an email it already had, re-asked timezone.
- **BUG-09:** AI tried to re-book a call that was already booked + link delivered; Call Details showed **Sat Jun 20** while the chat negotiated **Monday**.
- **BUG-10:** "give me one sec to get that locked in 🙏" fired 6× with nothing ever following.

### What the prod data shows (root cause confirmed)
From the Paris conversation:
- Lead said **"600usd" at 13:12** → AI asked "what've you got set aside" **7 times** (4 of them *after* 13:12). `capturedDataPoints` held `incomeGoal` and `deep_why` but **never the capital figure** → re-asked.
- Email given 14:59 → re-asked 16:25 (**after** a booking already existed).
- A real booking exists: `bookingId=8xEukmCe…`, `scheduledCallAt`, Zoom `bookingUrl`, `selectedSlot="2026-06-20T12:00:00Z"`. Yet the AI kept re-entering `BOOKING_CONFIRM` → re-booking → failing → firing the stall (the 5× "one sec", last one a literal dead-end).
- `selectedSlot` = **Sat Jun 20**, but `proposedSlots` offered Jun 20 / 21 / 23 (no Monday) while the AI said "monday works" → it booked a day it never actually offered.

**Root cause:** `bookingId / scheduledCallAt / selectedSlot / proposedSlots` and the captured capital were stored in the DB but **never fed into the AI's prompt context** (`conversationCallState` selected `scheduledCallAt` but never merged it into `leadContext.booking`). So the AI was blind to its own booking and re-asked / re-booked. The stall (BUG-10) had no operator notification, so a failed booking stranded the lead.

### The fix
1. **Feed booking state into the prompt** (`ai-prompts.ts` + `webhook-processor.ts`): `leadContext.booking` now carries `scheduledCallAt`, `bookingId`, `selectedSlotIso`, and `capitalStated`. The prompt's booking block now leads with **"✅ A CALL IS ALREADY BOOKED for <time> — do NOT propose times, re-ask email, or restart booking"** when a booking exists, and surfaces the already-stated capital so it's never re-asked.
2. **Code-level booking circuit-breaker** (`webhook-processor.ts`): before any auto-book attempt, if a real booking exists AND the lead is not explicitly rescheduling, **skip the re-book entirely** — no failed attempt, no stall line. (Backstop to the prompt rule.)
3. **Date-mismatch slot guard:** before booking, validate `selectedSlotIso` is actually one of the `proposedSlots` shown to the AI (2-min tolerance). It refuses to book a time that was never offered (R14).
4. **BUG-10 stall follow-through:** when a booking genuinely fails, the holding line now also **escalates to a human operator** (in-app + the standard escalation dispatch) so the lead is never left in a dead-end.

### Verification
- **Before:** prod evidence above (7× budget re-ask, email re-ask post-booking, Sat-vs-Monday slot, 5× dead-end stall).
- **After:** `tsc` clean; **all 486 unit tests pass** (incl. booking, script-progression, quality-gate suites — additive change, no regression). Definitive confirmation on the prod "after" run: drive Shazim 0→booking and confirm the happy path still books, no re-asking, no re-book loop, and the booked day matches what was agreed.

---

## BUG-08 — Image hallucination ✅ FIXED & VERIFIED

### What the client reported
> The AI sometimes invents what's in screenshots it can't process — e.g. *"damn bro that's a solid result fr"* on an FOMC screenshot it never read. Confidently describing trading it can't see is the most dangerous hallucination here.

### What the prod data shows (root cause corrected)
Checked every lead image in the Paris conversation. Important correction to the original hypothesis: **vision/OCR actually succeeded on almost every image** — each had `imageMetadata` populated with a description + extracted text. So Claude *did* receive a text description; it wasn't "empty OCR → hallucinate."

The real failure is **over-interpretation**: the 18:09 screenshot's auto-description was *"account balance, equity, and open positions"* — neutral — and the AI turned that into *"damn bro that's a solid result fr"*, asserting a **win/profit it cannot actually verify**. (The one honest "image isn't pulling through" was, ironically, on an image where OCR *did* work.)

### The fix (code-level guards, per client)
1. **At the render point** (`buildImageContextText`, `media-processing.ts`): the image context now carries an explicit guard — *"this is an auto-generated description, not the real image — do NOT claim it shows a win/loss/profit/result unless the extracted Text says so."* And when vision genuinely produced nothing usable, it emits a hard *"could NOT be read — do not describe or guess; ask the lead what it shows."*
2. **Outbound hard guard** (`scoreVoiceQuality`, `voice-quality-gate.ts`): when the lead's previous message was an image, a new `fabricated_image_result` hard-fail blocks unqualified result-claims ("solid/nice/big result/win/profit", "that's a W", "killing it", etc.) → forces a regeneration toward a neutral acknowledgment + "what's it showing?". This complements the existing `r_image_chart_advice` (no entries/targets) and `fabricated_image_observation` (no "I saw the chart") guards.

### Verification
- **Before:** prod evidence — "solid result fr" on a neutral balance screenshot.
- **After:** 4 new unit tests (the exact "solid result" line blocked; "nice win" blocked; no preceding image → allowed; neutral "what's it showing?" → allowed). 59 gate-related tests pass. `tsc` clean.

---

## ✅ PROD "AFTER" VERIFICATION — Shazim FB chat, 0 → booking (post-deploy)

Drove a fresh cold-start conversation on the live daetradez prod (Shazim FB, after deploying all fixes). Result: **clean 0→booking pass with every gating bug fixed.**

| Check | Result |
|---|---|
| 0 → booking completed | ✅ booked Wed Jun 24 7pm, `bookingId=lC0fsE7iSYKvxSE5GRIg`, Zoom link delivered |
| BUG-07 capital re-ask | ✅ "5k saved up" captured (HIGH confidence), **never re-asked** |
| BUG-07 email re-ask | ✅ email captured once, **never re-asked** |
| BUG-09 date match | ✅ `selectedSlot` = the **Wednesday** agreed in chat (Paris had Sat-vs-Mon mismatch) |
| BUG-09 re-booking | ✅ two post-booking messages → AI **confirmed the existing call** ("still on for wednesday 7pm"), did **not** re-propose times or restart booking |
| BUG-10 dead-end stall | ✅ **no "give me one sec to get that locked in" stall** (Paris fired it 5× at this exact point) |
| BUG-01 verbatim loop | ✅ replies varied throughout; no repeated line |
| BUG-02 truncation | ✅ all bubbles delivered complete (incl. the link bubble) |
| BUG-03 template leak | ✅ no scaffolding/placeholder text leaked |

**Still-open items observed during the run (MEDIUM / non-gating):**
- **Timezone mapping bug (new):** lead said "GMT+2, South Africa" but it stored `Europe/London` (should be `Africa/Johannesburg`) and labelled the slot "GMT+1". The booked instant is internally consistent, but the tz *label* is wrong. Feeds BUG-09's display. → fix queued.
- **BUG-14 reproduced:** a short question ("do you guys trade prop firms?") produced a reply opening "Could? brother…". → MEDIUM, queued.
- **BUG-06:** AI cycled discovery questions and dodged the prop-firm question before closing. → MEDIUM, queued.

---

## TZ mapping fix (new finding from the prod run) ✅ FIXED

### What surfaced
In the prod "after" run the lead said "GMT+2, South Africa" but it was stored as `Europe/London` (GMT+0/+1) — so the booked slot was labelled "GMT+1" instead of the lead's actual GMT+2. (Paris had the same `Europe/London` mis-map.) The booked instant is internally consistent, but the timezone *label* shown to the lead is wrong — the display half of BUG-09.

### Root cause
The AI emits `lead_timezone` as an IANA string, and the prompt schema only showed `America/New_York` / `Europe/London` as examples — so for a GMT+2 / South-Africa lead the model picked the nearest European-looking example.

### The fix
- **Code normalizer** `normalizeLeadTimezone()` (`ai-engine.ts`), applied at parse time so every downstream use gets the corrected value: maps region/offset phrases (South Africa/SAST/GMT+2 → `Africa/Johannesburg`, plus Nigeria/Kenya/Ghana/UAE/India/Australia and bare GMT±N offsets) to the right IANA zone, validates real IANA zones, and leaves correct ones untouched.
- **Prompt hint** widened so the model emits the right zone in the first place (esp. `Africa/Johannesburg` for SA / GMT+2).

### Verification
5 unit tests pass (SA/SAST/GMT+2 → Africa/Johannesburg; other regions; valid zones untouched; null handling). `tsc` clean.

---

## BUG-06 — AI dodges direct questions ✅ FIXED (MEDIUM)

### What the client reported
> The lead asked concrete questions repeatedly and the AI deflected every time, looping back to qualification: pricing asked ~4× and never answered ("do you teach courses", "what strategy", "are you selling it or not", "how much do you sell it"), "do you have a WhatsApp group" → deflected. Dodging the same question 4× reads as evasive — a top disengagement cause.

### Root cause
The gate had an `ignored_personal_question` detector ("hbu", "what do you trade") but **no detector for pricing/logistics questions** ("how much", "are you selling it", "do you have a whatsapp group", "how does it work"). Those aren't "personal", so they slipped every existing guard and the AI was free to deflect to the script.

### The fix
- New `detectDirectQuestion()` (`conversation-detail-extractor.ts`) with pricing + product/logistics patterns.
- New `ignored_direct_question` soft signal (−0.5) in `scoreVoiceQuality`: when the lead's last message was a direct question and the reply neither answers it (price/number/product term) nor explicitly defers it to the call, it penalizes — combined with any other miss it forces a regen that answers first. Matches the existing `ignored_personal_question` weighting.

### Verification
13 unit tests pass (7 question shapes detected; non-questions ignored; dodge penalized; answer/defer not penalized; no-question not fired). 46 gate-related tests pass. `tsc` clean.

### Note
This is a quality nudge, not a hard block (legit "let's cover that on the call" deferrals are valid). It pushes the AI to acknowledge the question before advancing, rather than ignoring it outright.
