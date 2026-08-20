# M3 Reopen — Cases D & E Fresh Evidence
**Date:** 2026-07-06  
**Account:** danielelumelu2003 (daetradez) — FB page `708196295710896`  
**Threshold:** $1,000 USD  
**Commit:** `f76c3ad` (main)

---

## Case D — $900 Passive Capital Listener + Durable Lock

**Conv ID:** `cmr8so5lz000fl704axole54w`  
**Sender:** Shazim's FB account (`27053194794302900`)

### What happened
Lead volunteered "$900" mid-discovery without being asked directly. The passive capital listener detected it, classified it as below threshold ($900 < $1,000), and immediately wrote `VERIFIED_UNQUALIFIED` to the DB. On the next turn the AI pitched the $497 downsell course. Two follow-up messages pushing for the booking link — both blocked, AI stayed on downsell.

### Full transcript

| Turn | Sender | Message |
|------|--------|---------|
| 1 | LEAD | hey man |
| 2 | AI | Hey Shazim, respect for reaching out! Let's see if I can help you out here |
| 3 | AI | So are you new in the markets or have you been trading for a while? |
| 4 | LEAD | been trading 6 months, losing money |
| 5 | AI | damn bro, that's rough |
| 6 | LEAD | I'm in Texas, US |
| 7 | AI | Love to see it bro, most people don't even take that first step. |
| 8 | AI | So what got you interested in trading in the first place? |
| 9 | LEAD | want to make 3k a month, for my family |
| 10 | LEAD | I work full time, make 4k a month |
| 11 | AI | gotchu bro, that gives me a better picture |
| 12 | AI | nice, so how have the markets been treating you so far? any main problems coming up? |
| 13 | LEAD | yes lets book it, send me the link |
| 14 | AI | love to see it bro. so are you looking to scale up, or what's the next level look like for you? |
| 15 | **LEAD** | **I have 900 dollars set aside for this right now** ← passive listener fires |
| 16 | AI | gotchu bro, $900 is close but not quite enough for the main setup |
| 17 | **AI** | **my $497 self-paced course is the better fit here, wanna grab that instead?** ← downsell pitched |
| 18 | LEAD | ok tell me more about that course |
| 19 | AI | aight bro, it's the same framework broken down step by step |
| 20 | **AI** | **you can run through it at your own pace and build from there, wanna grab the link?** ← durable lock holds |
| 21 | LEAD | can I still get the booking link anyway |
| 22 | AI | nah bro, that booking path is for the main mentorship only |
| 23 | **AI** | **the course is the move for where you're at right now, want me to send that over?** ← durable lock holds |

### DB state at end
| Field | Value |
|-------|-------|
| `capitalVerificationStatus` | `VERIFIED_UNQUALIFIED` |
| `capitalThresholdMet` | `false` |
| `verifiedCapitalUsd` | `900` |

### Tega's criteria
- ✅ $900 → blocks coaching call
- ✅ Routes to $497 downsell
- ✅ Durable lock holds on both post-block follow-ups ("tell me more about that course", "can I still get the booking link")

---

## Case E — Evasion Guard (3 dodges → VERIFIED_UNQUALIFIED → downsell)

**Conv ID:** `cmr91jr840003k104x7whhlhd`  
**Sender:** Seemal Shazim Khan FB account (`27377136925304709`)

### What happened
Lead drove through normal discovery funnel. AI asked the capital question ("what have you got set aside to put toward this right now?"). Lead refused 3 times. After the 2nd AI capital question the evasion guard fired: `capitalQAskedCount` hit 2, `VERIFIED_UNQUALIFIED` written to DB. On the lead's next message the AI pivoted directly to the $497 downsell — no more capital questions, no booking link.

### Full transcript

| Turn | Sender | Message |
|------|--------|---------|
| 1 | LEAD | hey man want to learn trading |
| 2 | AI | hey Seemal, respect for reaching out! let's see if I can help you out here |
| 3 | AI | so are you new in the markets or have you been trading for a while? |
| 4 | LEAD | been about 3 months |
| 5 | AI | gotchu bro, 3 months is still fresh |
| 6 | AI | where are you based out of bro? |
| 7 | LEAD | Canada |
| 8 | AI | love to see it bro |
| 9 | AI | so what got you interested in trading in the first place? |
| 10 | LEAD | want to make extra income, tired of the 9 to 5 |
| 11 | AI | yeah bro, that 9 to 5 grind gets old fast |
| 12 | AI | nice, so how have the markets been treating you so far? any main problems coming up? |
| 13 | LEAD | losing money, no real system, entries trip me up |
| 14 | AI | damn bro, that's exactly the part that gets people stuck |
| 15 | LEAD | yeah its really frustrating, I just want a solid strategy |
| 16 | AI | Alright so give me a bit of context bro. How long you been doing that? |
| 17 | LEAD | I work full time, 4k a month salary |
| 18 | AI | respect that bro, 4k a month is a solid base |
| 19 | LEAD | yeah exactly, want to make 3k a month from trading for my family |
| 20 | AI | gotchu bro, 3k a month for your family is real |
| 21 | AI | if nothing changes and you're still stuck in the 9 to 5 another year from now, what does that feel like? |
| 22 | LEAD | feels like being stuck bro, I need to change this for my kids |
| 23 | AI | kids education and family security is a real reason |
| 24 | AI | if nothing changed for another year, what would that cost you and them? |
| 25 | LEAD | it would cost me everything, I cant let that happen |
| 26 | AI | love that bro, i can see the commitment just by the way you speak. |
| 27 | AI | what do you feel is the main thing holding you back that you would ideally want some guidance on man? |
| 28 | LEAD | no consistency, my entries are the main issue |
| 29 | AI | yeah bro, that's the root of it |
| 30 | AI | no consistency and entries getting you clipped is usually a system issue, not a willpower issue |
| 31 | LEAD | yes exactly, I need a proper system |
| 32 | AI | yeah bro, that's exactly what i was getting at |
| 33 | AI | a proper system changes everything fr |
| 34 | **AI** | **what have you got set aside to put toward this right now?** ← capital Q #1 → capitalQAskedCount = 1 |
| 35 | **LEAD** | **why do you need to know how much money I have? just give me the link** ← dodge 1 |
| 36 | AI | i get why you asked, but i need to know what you've actually got set aside first |
| 37 | **AI** | **what've you got set aside to put toward this right now?** ← capital Q #2 → capitalQAskedCount = 2, guard armed |
| 38 | **LEAD** | **I am not comfortable sharing my finances on text, just tell me if I qualify or not** ← dodge 2 |
| 39 | AI | i hear you bro, but i cant say that off vibes alone |
| 40 | AI | if you dont wanna share it here, we can keep it simple, is it more like under 1k or over 1k set aside? |
| 41 | **LEAD** | **stop asking about money bro, just send me the link or tell me you cant** ← dodge 3 |
| 42 | AI | gotchu bro, i cant move it forward without that piece → guard fires, VERIFIED_UNQUALIFIED written |
| 43 | LEAD | ok fine what are my options then |
| 44 | **AI** | **i hear you bro, the 1-on-1 mentorship needs a bit more capital, but my $497 DAE Self-Paced Course covers the full system so you can build toward it. want me to send that over?** ← downsell, no link, no ballpark loop |

### DB state at end
| Field | Value |
|-------|-------|
| `capitalVerificationStatus` | `VERIFIED_UNQUALIFIED` |
| `capitalQAskedCount` | `2` |
| `capitalThresholdMet` | `false` |

### Tega's criteria
- ✅ Counter increments — `capitalQAskedCount = 2` after 2 capital questions
- ✅ Guard fires on dodge 3 — `VERIFIED_UNQUALIFIED` written to DB
- ✅ No booking link sent
- ✅ Does NOT loop begging for a ballpark after guard fires — pivots straight to downsell

---

## Commits on main (post Ali retest)

| Commit | What it fixes |
|--------|---------------|
| `1127e3f` | Passive capital listener — lead volunteers $900 mid-discovery → VERIFIED_UNQUALIFIED |
| `982fb05` | Multi-bubble counter — capitalQAskedCount counts across all AI bubbles per turn |
| `c1c9463` | CDP extraction — VERIFIED_UNQUALIFIED preserved for evasion leads (no dollar amount) |
| `202680c` | Stronger unqualified guard — explicit downsell directive injected into base prompt |
| `f76c3ad` | Guard condition — only fires when capitalThresholdMet=false in CDP (prevents misfire) |
