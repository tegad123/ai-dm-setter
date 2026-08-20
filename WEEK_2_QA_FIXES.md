# Week 2 — Bug fixes for QA

**Period:** 2026-05-22 → 2026-05-30
**Total bugs closed this week:** 18

This is the QA-facing summary. Each entry has the bug ID, what was happening, what we did about it in plain language, and the exact steps to verify the fix.

---

## Quick map — what to test

| ID | One-liner |
|---|---|
| QD-014 | Call dates that are years out are now rejected |
| QD-046 | The tag picker on the Leads page now shows your account's tags |
| QD-003, QD-024, QD-043, QD-044, QD-045, QD-048 | Out-of-credit / rate-limit errors now show a clean message instead of raw JSON |
| QD-032, QD-033, QD-034, QD-035, QD-036, QD-037, QD-038 | The Overview, Pipeline, and Funnel pages now report matching numbers |
| QD-039 | "With Stage Data: 0" no longer shows on accounts that have real conversations |
| QD-040 | "Cold Start Thresholds 0/50 0/30 0/20" now shows different, accurate numbers per feature |
| QD-041 | The Conversation Funnel chart is no longer empty on accounts that have qualified conversations |

Plus two non-numbered fixes:
- The **Disconnect** button on the Google Calendar card was returning an error. It now disconnects cleanly.
- If Google ever revokes the calendar token (which it does for OAuth apps in "Testing" mode after 7 days), the app now auto-marks the integration disconnected and posts a notification telling the operator to reconnect. Before, every booking would silently fail and a human had to notice.

---

## Detailed entries

### QD-014 — Booking accepts year 2099 dates

**What you saw:**
Operators could pick a call date several years in the future on the Call Details panel and save it. There was no upper bound. Easy to typo a year and not notice.

**What we did:**
Added a 6-month cap on call dates. The fix is in three places so it can't slip through:
1. The date picker's native control won't let you go past 6 months from today.
2. The "Save" button on the Call Details panel now shows a red toast if you somehow get a too-far date in there.
3. The server rejects any save attempt past the cap, so even a direct API call can't bypass it.

**How to verify:**
1. Open any lead's Call Details panel.
2. Try to pick a date 1 year out → the date picker should not allow it.
3. If you can type a date directly: enter `2027-01-01` and click Save → you should see "Call date cannot be more than 6 months from now" and the save should fail.
4. Pick a date 30 days out → saves normally.

---

### QD-046 — Tags created in Settings don't appear in Leads

**What you saw:**
You create a tag in Settings → Tags. You go to the Leads page, open a lead, click the tag picker — it's empty. The tag you just created is nowhere.

**What we did:**
The tag picker was always showing empty for everyone. The bug was in how the page loaded the tag list — it was looking in the wrong place inside the API response and silently falling back to an empty list every time. Fixed.

**How to verify:**
1. Go to Settings → Tags. Create a new tag (e.g. "test-qa").
2. Go to Leads. Open any lead.
3. Click the "Add tag" / tag picker dropdown.
4. The "test-qa" tag should appear in the list along with any other tags on the account.
5. Pick it. It should attach to the lead and show as a chip.

---

### QD-003 / QD-024 / QD-043 / QD-044 / QD-045 / QD-048 — Raw JSON errors when API key runs out

**What you saw (across all six):**
When an OpenAI or Anthropic API key ran out of credit, hit a rate limit, or was invalid, the dashboard would dump a wall of raw JSON text into the screen instead of a useful message. QA reports flagged this in six different places:
- The test-message tool (QD-003, QD-045)
- The persona generation step (QD-024)
- The persona script editor (QD-048)
- The training-upload screen (QD-043)
- The voice-note processing screen (QD-044)

**What we did:**
Built one shared error handler that recognizes the common provider failures (out of credit, rate limit, invalid key, provider overloaded, timeout) and converts each into a clean human message. Then wired it into every operator-facing screen that calls AI. Examples of what you'll see now:
- Out of credit: *"Your AI provider account is out of credit. Add billing/credit (or update the API key) in Settings → Integrations, then try again."*
- Rate limit: *"The AI provider is rate-limiting requests right now. Wait a few seconds and try again."*
- Bad key: *"The AI API key is missing or invalid. Re-enter it in Settings → Integrations."*

**How to verify:**
1. In Settings → Integrations, replace the OpenAI or Anthropic key with garbage (e.g. `sk-invalid-test`).
2. Try each of these flows. Each one should now show a friendly message, not raw JSON:
   - Settings → Persona Editor → "Test message" tool
   - Settings → Persona → run "Generate from documents"
   - Settings → Persona → edit a script section
   - Settings → Training → upload a document and trigger structure extraction
   - A voice note → "Process" button
3. After verifying, restore the real key in Settings → Integrations.

---

### QD-032 through QD-038 — Numbers don't match across Overview, Pipeline, and Funnel

**What you saw:**
The Overview page would say "qualified: X." The Funnel chart on the Analytics page would say "qualified: Y." The Pipeline / Leads page would show a third number. Same account, same data, three different totals.

The most flagged ones were:
- QD-032: Overview vs Pipeline numbers don't match
- QD-033 → QD-038: same pattern, different metric rows (Calls Booked, Show Rate, Close Rate, etc.)

**What we did:**
The codebase had three different definitions of "qualified" living in three different files. Same for "booked." Same for "showed up." Each page was using its own definition. We created one shared definition and pointed every page at it. So now Overview, Funnel, Pipeline, and the Conversations tab all answer the same question the same way.

We also fixed a cold-pitch / spam filter that was being applied to the "Total Leads" count but not to the "Calls Booked" count — meaning even within a single page, the two numbers were measuring slightly different lead populations. Now the filter is uniform across all main-funnel metrics.

**How to verify:**
1. Pick an account that has at least 5–10 leads in mixed stages.
2. Open these in three tabs and compare:
   - Analytics page → Funnel chart "Qualified" number
   - Conversations tab → "Qualified" filter → row count
   - Leads page → filter by stage = "QUALIFIED" → row count
3. The Funnel chart's "Qualified" number should equal the Conversations tab's "Qualified" count.
4. Same check for "Booked": Funnel "Booked" number = Conversations or Leads filter for booked stages.
5. If you tag a lead with `cold-pitch`, it should disappear from Funnel / Overview totals (it's expected to stay visible in the raw Leads list with the cold-pitch tag).

---

### QD-039 — "With Stage Data: 0" shown on accounts that clearly have stage data

**What you saw:**
Open Settings → Training → Data Quality (or wherever the data-quality panel surfaces) on an account that has 22 active conversations and clear AI replies. The "With Stage Data" metric shows 0. Looks broken.

**What we did:**
The metric was counting "messages with stage tagged" across *all* messages — including lead messages and supportive/handoff messages that legitimately don't have a stage. So even on a perfectly healthy account, the ratio was dragged toward zero. We changed the denominator to count only AI-pipeline messages (the ones that *should* have stage data), so the number now reflects what it's actually measuring.

**How to verify:**
1. Pick an account with at least a few AI-generated replies.
2. Open the Data Quality / Training Analysis panel.
3. The "With Stage Data" metric should now show a real, positive number (not 0).
4. The number should be close to the count of AI messages on the account.

---

### QD-040 — Cold Start Thresholds showing 0/50, 0/30, 0/20

**What you saw:**
The cold-start gates (the panels that show "feature ready when X conversations exist") were displaying 0/50, 0/30, 0/20 — three different thresholds, but they all reported the same 0 progress regardless of how much data the account had.

**What we did:**
The helper that does the cold-start check was silently ignoring the threshold each caller was passing in — it always checked against the same default. So every panel got the same answer. Fixed so each panel checks against its own threshold.

**How to verify:**
1. On an account with, say, 35 messages, open the Data Quality panel.
2. The cold-start row for Message Effectiveness (threshold 30) should now show "ready" or a real progress like "35/30" instead of "0/30".
3. The cold-start row for Segment Analysis (threshold 20) should also reflect real progress against 20.
4. The threshold numbers in the labels (50, 30, 20) should each have their own progress, not all read 0.

---

### QD-041 — Conversation Funnel chart is empty

**What you saw:**
The Conversation Funnel chart on the Analytics page showed zero on every stage even though the account had real conversations that had clearly walked through booking.

**What we did:**
The chart was counting how many conversations reached each of the AI's 7-step funnel. But the count included conversations from before the new 7-step funnel rolled out — those have no per-step timestamps so they sat at zero, dragging the chart to look empty.

The chart now restricts itself to conversations that actually entered the new funnel, and returns the count of conversations included vs excluded so the UI can label "showing N of M." The chart will look correct now on any account that has had even one conversation walk the AI funnel.

**How to verify:**
1. Pick an account that has at least one conversation where the AI advanced through stages (you can see this by clicking into the conversation — it should show stage badges on the messages).
2. Open the Analytics page → Conversation Funnel chart.
3. The chart should show real numbers at each stage (Opening, Situation Discovery, Goal / Emotional Why, etc.) instead of all zeros.
4. If only some conversations are included (because others are pre-rollout), the response now carries `excludedPreSop` and `funnelDenominator` so any UI label showing "N of M" will be accurate.

---

### Non-numbered — Google Calendar "Disconnect" button was returning an error

**What you saw:**
On the Settings → Integrations → Google Calendar card, clicking "Disconnect" did nothing visible. Open the browser network tab — the request was returning HTTP 400.

**What we did:**
Pure plumbing. When adding Cal.com to the same panel, Google Calendar was accidentally left off the list of providers the disconnect endpoint accepted. Added it back.

**How to verify:**
1. Settings → Integrations → Google Calendar.
2. If currently connected, click Disconnect → should succeed, badge flips to "Not Connected", confirmation toast shows.
3. Reconnect via "Connect Google Calendar" button → should work as before.

---

### Non-numbered — Google Calendar token auto-handling

**What you saw (not yet flagged by QA, but worth knowing):**
Roughly every 7 days, Google was silently revoking the calendar refresh token (this is Google's policy for OAuth apps in "Testing" publishing status). After that, any AI booking attempt failed quietly. A human had to notice that no calls were being created.

**What we did:**
Added auto-detection. When Google returns the `invalid_grant` signal, the app now marks the Google Calendar integration as disconnected and creates a SYSTEM notification telling the operator to reconnect from Settings → Integrations. The booking flow surfaces a clean operator-facing message rather than a silent failure.

This will go away permanently once the OAuth consent screen is published to production (a Google Cloud Console setting, on the engineering side). The auto-detect handles the meantime gracefully.

**How to verify:**
Hard to repro without manually revoking the token. If it happens organically, you should see:
1. A SYSTEM notification on the dashboard titled "Google Calendar disconnected".
2. The Google Calendar card in Settings → Integrations showing "Not Connected".
3. Reconnecting the calendar (clicking "Connect Google Calendar") works and restores normal operation.

---

## Calendar layer note

This week the calendar layer was also verified end-to-end on the test account:

- AI books a call → real event created on the connected Google Calendar with a real Meet link
- Confirmation message sent to the lead
- Reminder sequence queued (morning-of, day-of confirmation, pre-call reminder)
- The "Active booking calendar" selector in Settings → Integrations lets the operator pick which calendar the AI uses (Google, Calendly, Cal.com, or LeadConnector — all four are connectable)

Worth a short manual QA pass once we deploy: connect a calendar, set it as active, drive a lead through to the booking step, confirm the event appears on the calendar and the lead receives the confirmation message.

---

## What's not covered here

- Phase 2 features (Conversation Takeover, Voice Notes polish, Follow-Up Picker, Objection Library, Setter Goal, Lead Memory) are scoped for the next milestone.
- A few non-blocker bugs remain in the backlog and will be picked up during Phase 2 alongside the feature work.

If anything above doesn't reproduce in the expected way, ping me with the account + screenshot and I'll investigate same day.
