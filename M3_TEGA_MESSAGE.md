# Message for Tega — M3 SQA Sign-Off

---

Hey Tega,

All 6 R24 cases are passing on production daetradez. Here's the full rundown.

---

**Test results (conv IDs as evidence):**

| Case | Scenario | Conv ID | Result |
|---|---|---|---|
| A | $5k → qualified | cmr6bgbb3000dkt04nswgn3au | ✅ VERIFIED_QUALIFIED, booking sent |
| B | $500 → below threshold | cmr6ev5sn005ol404p75tv0cv | ✅ VERIFIED_UNQUALIFIED, $497 course pitched |
| C | $1,000 exact boundary | cmr6f8smp0013le04fsrqbjd3 | ✅ VERIFIED_QUALIFIED, booking confirmed |
| D | $900 + post-block follow-ups | cmr6nstp30038la04tl6h4czu | ✅ VERIFIED_UNQUALIFIED, durable lock held on both follow-ups |
| E | Evasion — dodge capital Q 3x | cmr76t1vd0003js04sshyv86d | ✅ VERIFIED_UNQUALIFIED, no link sent |
| F | takeprofittrader funded account | cmr77d4zw009tji04i73ldebc | ✅ VERIFIED_UNQUALIFIED, asked for personal capital |

Final commit on main: `6a72584`

---

**What was fixed and how:**

**Case D — Terminal Downsell State**
You asked for an explicit CLOSED state once the downsell is delivered. Done. When `capitalVerificationStatus = VERIFIED_UNQUALIFIED` is written, every subsequent turn hits an early-return guard that routes straight back to the downsell directive without re-scanning. The lead can send 10 follow-up messages — none of them will re-open the capital question or offer a booking slot.

**Case E — Evasion Gate**
Your note was right — the old approach was regex pattern matching on AI message history, which breaks every time the AI invents a new phrasing. We replaced it with a persistent DB counter (`capitalQAskedCount` on the Conversation table). Every time `generateReply()` produces a message that contains a capital question — detected by the same `containsCapitalQuestion` classifier already used throughout the engine, not a new regex — the counter increments atomically. The evasion guard reads the counter (≥2), not message history. No new phrasing the AI invents can bypass it. Tested: lead dodged 3 times, guard fired, `VERIFIED_UNQUALIFIED` written, no link sent.

**Case F — Capital Classification Layer**
Also correct — the fix isn't string-matching prop firm names, it's ensuring prop-firm detection writes `VERIFIED_UNQUALIFIED` durably (same as any other unqualified outcome), so Case D's durable lock takes over from there. The `takeprofittrader` addition is a belt-and-suspenders — the real structural fix is that `answer_prop_firm_only` now persists the same way `answer_below_threshold` does. Once that UNVERIFIED_QUALIFIED state is written, any phrasing on any subsequent turn gets blocked.

**Double-message**
Confirmed as Meta webhook retry behavior — not a code regression. When the first POST to our webhook is slow (cold DB connection during test bursts), Meta fires a second POST with the same message ID before our unique constraint commits. Existing dedup layers handle the majority of cases. Worth a Redis-based distributed lock in a future sprint if it becomes a prod complaint, but not blocking M3.

**One additional fix found during testing (not in Ali's report):** After R24 blocked a reply, the LLM regen was producing scheduling proposals like "you free monday at 11am EDT?" — which `isRoutingToBookingHandoff()` didn't catch, so the regen shipped without re-applying the block. Fixed in `3a36232` — day+time scheduling proposals now treated as booking-handoff attempts.

---

Full technical detail in `M3_SQA_SIGNOFF.md` in the repo if you want to review the root causes and code locations.

Ready for M3 close on the R24 gate side.
