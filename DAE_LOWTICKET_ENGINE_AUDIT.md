# DAETRADEZ Low-Ticket Persona — Full Engine-Config Audit & Readout

**Persona:** `cmpy59zz30002ju04v1bjdwzw` ("Dae") · **Script:** DAETRADEZ — B2C DM Website Funnel V1 (8 steps, no qualification, no booking)
**Audited against:** production config + full engine code sweep (every subsystem)
**Status:** all fixes implemented, typechecked, production build passing, committed locally — **nothing deployed until this readout is reviewed.**

---

## 1. Toggle Table — toggle → current → correct → action

| Toggle / config | Current | Correct | Action |
|---|---|---|---|
| `minimumCapitalRequired` | **1000** ❌ | null | **Config fix — THE R24 driver.** Nulling it disarms every engine capital channel: the R24 prompt rule, the script-branch inject, the "before we lock anything in" fallback (the live Alii Raza leak), the call-pitch-before-capital hard gate, the passive capital listener, the evasion guard, and ALL $497 downsell routes (each is downstream of a capital failure) |
| `skipR24ScriptInject` | true ✅ | true | Correct as-is — but it only kills the **script** injection channel, which is exactly why the leak fired anyway: the **engine** channels run off the threshold |
| `allowEarlyFinancialScreening` | **true** ❌ | false | Config fix — prompt-level (the early-financial-screening carve-out block). Will be confirmed before/after in the built prompt, not skipped as minor |
| `promptConfig.disableLeadStageProgression` | true ✅ | true | Correct (Blocker 2 gate, holding) |
| `closerName` | **'Anthony'** ❌ | null | Config fix — while set, the prompt carries a full "the call is with Anthony" handoff-identity block + closer scope rule. Nulling it (plus archiving `promptConfig.callHandoff`) removes all closer/call framing from the prompt |
| `promptConfig.typeformUrl` | **form.typeform.com/to/AGUtPdmb** ❌ | archived | Config fix — this exact URL is also the hardcoded trigger for the 30-min booking-link follow-up machinery. Archiving it removes the "Typeform / booking URL" line from the prompt AND makes that machinery untriggerable |
| `promptConfig.homeworkUrl` | **call-prep page URL** ❌ | archived | Config fix — injects a "CALL HOMEWORK PAGE" section with call-preparation instructions into the prompt of a persona that books no calls |
| `promptConfig.assetLinks.bookingLink` | same typeform URL ❌ | archived | Config fix — same reasoning as typeformUrl |
| `financialWaterfall` (capital + credit questions) | populated | leave (latent) | No action — only reaches the prompt on the legacy tenant-data path; this persona runs the parsed-script path. Flagged as latent risk if the persona ever loses its parsed script |
| `downsellConfig` ($497 self-paced) | populated | leave | No action — every downsell route requires a capital-failure signal, all dead once the threshold is null. The one exception (hardship early-exit) is code-gated, see §2 |

All config changes are **reversible** — original values are archived under `promptConfig._highTicketArchived`, and the fix script has a `--revert` mode. Full before/after printed on apply for the evidence record.

---

## 2. Residual Paths That SURVIVE a Null Threshold — code-gated (verification focus)

These are the paths that a one-field fix would have missed. Each is now gated in code:

1. **Capital-hardship early-exit.** Fires on explicit hardship phrases ("I'm broke", "no money") with **no threshold guard**. It force-writes `capitalVerificationStatus = VERIFIED_UNQUALIFIED`, soft-exits the conversation, and pitches the $497 downsell — on a persona with no capital bar to fail. **Fix:** now requires a configured capital threshold; dead on this persona, unchanged on qualification personas.

2. **Typeform screen-out.** Fires on a text-regex coincidence (AI message resembles "what day and time did you book" + lead replies "not yet / just the form"). Writes `Conversation.outcome = UNQUALIFIED_REDIRECT`, marks the lead UNQUALIFIED, and ships the fixed high-ticket soft-exit ("the team will review your application…"). It was exempt from the Blocker-2 suppression. **Fix:** gated on the persona flag at BOTH the webhook entry point and the engine backstop.

3. **`selectedSlotIso` (hallucinated booking slot).** The Blocker-2 suppression nulled `stage`/`subStage` but left the LLM-emitted booking slot intact — auto-book survived on a single guard. **Fix:** now nulled together with stage/subStage. Defense-in-depth.

---

## 3. Confirmed Dead — no action needed (verified in code, listed for completeness)

- **Booking-link follow-up (30-min check-in):** triggers only on an exact hardcoded typeform URL match — and that URL is being archived anyway
- **Auto-book / AI `scheduledCallAt` writes:** dead on the nulled `subStage` (Blocker 2), now double-covered by the `selectedSlotIso` null
- **Call-confirmation / no-show / pre-call sequences:** all require a real `scheduledCallAt` to exist first; no self-arming cron
- **Calendar book route:** operator-authenticated only, not engine-reachable
- **Stage writes / stage engine / scoring / inbound classifier:** gated by the Blocker 2 fixes (holding, verified)
- **Voice-note slot actions:** pre-recorded audio assets, not calendar bookings
- **Legacy promptConfig scripts (financialScreeningScripts, bookingScripts, callPitchMessage, qualificationQuestions, disqualification\*):** only reach the prompt on the legacy path this persona doesn't use — latent only

---

## 4. NEW Finding From the Audit — the funnel link itself is broken

Step 8 ("Funnel to Website") sends `{{WEBSITE_LINK}}` — a runtime placeholder the AI fills from its prompt context. **No website-funnel URL exists anywhere in the persona config.** `assetLinks` holds only the typeform booking URL and literal placeholder strings (`[FREE VALUE VIDEO LINK]`, `[DANIEL ORIGIN VIDEO LINK]`).

Verified in the live Alii Raza conversation: the AI said *"This breaks down exactly how we help people go from where you're at to $1k, no fluff."* — **and no link followed.** The account's complete URL send history contains only YouTube links, Zoom links, and the call-prep page. A website funnel link has **never** been sent.

**The funnel's terminal action silently delivers nothing.** Even with every leak fixed, the funnel cannot do its one job until the real website URL is configured.

**→ Needed from you/Daniel: the actual website funnel URL.**

---

## 5. Decision Item — follow-up chase chain (your call, unchanged until you decide)

The generic 12h silent-lead chain ("yo bro you still there?" → soft exit) **will fire** on silent low-ticket leads. The bodies are generic re-engagement — no call pitch (the booking-flavored variants are only reachable via the booking-link follow-up, which is dead). Options:

- **Keep** — re-engagement nudges toward the link (recommended default)
- **Gate** — low-ticket leads get no automated chase

---

## 6. Verification Plan (per your bar — trip the surviving paths, not happy-path)

On **both** test accounts (Shazim + Seemal), after deploy + config apply:

| # | Probe | Pass condition |
|---|---|---|
| a | Normal run → link-delivery step + 2 turns past | No capital question, no financial screen, no crash/stall |
| b | **Hardship probe** — "honestly im broke rn" mid-flow | No `VERIFIED_UNQUALIFIED` write, no $497 pitch, conversation continues normally |
| c | **Typeform screen-out probe** — reply "not yet, just filled the form" style answers | No `UNQUALIFIED_REDIRECT`, no high-ticket soft-exit |
| d | `allowEarlyFinancialScreening` | Before/after diff of the built system prompt |
| e | Regression | Blocker 1 (packed message, no re-ask) + Blocker 2 (zero stage writes, `Message.stage` null, panel hidden) still pass |
| f | DB snapshot (extended script) | `capitalVerificationStatus` UNVERIFIED, zero capital CDP keys, **no capital/screening language in any AI message** (regex probe), no `scheduledCallAt`, no screen-out flag, plus all Blocker-2 assertions |

Qualification personas: none of the new gates touch them — every gate keys on the capital threshold or the persona flag, both absent/off elsewhere.

---

## 7. Status & Sequence

- ✅ Audit complete (code + prod)
- ✅ Code gates implemented, typechecked, production build passing — committed locally, **not pushed**
- ✅ Config fix script written, reversible (`--verify` / `--revert`), **not run**
- ⏳ Awaiting: your ack on this readout + the website funnel URL
- Then: deploy (~3 min) → config apply → full verification above → evidence package → **Ali's independent pass targeted at the surviving paths specifically**

Timeline: well inside the 24h window. Launch is not at risk from this side once the URL lands.
