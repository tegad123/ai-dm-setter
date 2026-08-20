# M3 Close — Evidence Report
**Date:** 2026-07-03  
**Commit:** `af31e08` — `fix(m3): Marcus third-person persona leak + deep-why context loss`

---

## Config Prerequisite — daetradez threshold (unblocks Ali's item 3)

| Field | Value |
|---|---|
| Persona | Dae (`cmnpuebgc0001jm04p17argb8`) |
| `minimumCapitalRequired` | **1000** (was null) |
| Downsell product | DAE Self-Paced Course — $497 |
| Downsell pitch | populated ✅ |
| Set on | 2026-07-03 |

Ali can run item 3 now.

---

## Item 1 — Marcus Third-Person Persona Leak

### Bug
Apex persona name is **"Marcus Apex Rivera"**, closer name is **"Marcus"** — same person.  
The system prompt used `{{closerNamePrompt}}` which resolved to "Marcus", causing the AI to say *"let's get you locked in with Marcus"* as if introducing a different person.

### Fix
- When `personaName` and `closerName` share the same first name, a hard identity directive is injected into the base system prompt on **every turn**:  
  > *"You ARE Marcus. NEVER refer to yourself in third person. FORBIDDEN: 'get on with Marcus', 'locked in with Marcus'. First person only."*
- Quality gate also scans each generated reply for `"with Marcus"` / `"Marcus will"` patterns and **forces a regen** if found.

### Evidence

**BEFORE** — conv `cmr3avz2x002ilb04dbfih5j5`

> Lead [msg 44]: *"yeah sounds good lets book"*  
> AI [msg 45]: *"yo bro love that, **let's get you locked in with Marcus**"* ❌ third-person self-reference

**AFTER** — conv `cmr4t4kxu0003l504ktp4okhb` (post-commit `af31e08`)

> Lead [msg 55]: *"yeah sounds good lets book"*  
> AI [msg 56]: *"real quick before we lock anything in, how much capital do you have set aside..."*  
> Lead [msg 57]: *"i've got about 3000 pounds ready to go"*  
> AI [msg 58]: *"**Let's go, here's the link to grab a time that works for you:**"* ✅ first person throughout — zero "Marcus" third-person references across all 60 messages

---

## Item 2 — Deep-Why Context Loss (Steps 11–13)

### Bug
When a lead volunteers their motivator (family, kids, house, etc.) mid-answer, the `deepWhy` CDP slot wasn't being extracted. The gate check `deepWhyCapturedForStep10` stayed false, and the engine allowed the AI to jump straight to the step 13 obstacle question — ignoring what the lead just shared.

### Fix
New gate flag `deepWhyContextIgnoredFailed` fires when:
- Lead's last message contains motivator keywords (family / kids / daughter / son / house / home / car / freedom / dream)
- `deepWhy` not yet captured in CDP
- AI's reply is at `OBSTACLE_IDENTIFICATION` stage or script step ≥ 13

Forces a regen with a directive quoting the lead's actual words, requiring specific acknowledgment before the obstacle question fires.

### Evidence

**BEFORE** — conv `cmr3avz2x002ilb04dbfih5j5`

> Lead [msg 37]: *"for my daughter, want to be there for her"*  
> AI [msg 38]: *"**Is there something more personal underneath it, like a person you're doing this for**"* ❌ ignored the explicit motivator, kept probing as if it hadn't been said

**AFTER** — conv `cmr4t4kxu0003l504ktp4okhb` (post-commit `af31e08`)

> Lead [msg 28]: *"the deeper reason is my kids. i want to be there when they come home from school, not stuck in an office"*  
> AI [msg 33]: *"**the kids being the reason is real, bro. what's been the main thing stopping you from getting a system in place**"* ✅ acknowledged the motivator specifically, then advanced

---

## Item 3 — R24 Gate Paths (Ali's)

Config is set on daetradez. Ali owns the six test paths:

| Path | Scenario | Expected |
|---|---|---|
| A | $5k stated → booking | thresholdMet=true, booking handoff |
| B | $500 stated → downsell | thresholdMet=false, course pitch |
| C | Exactly $1k → confirm boundary | thresholdMet=true (inclusive) |
| D | $900 stated → blocked | thresholdMet=false |
| E | Dodge / no amount → probe | re-ask capital Q |
| F | Messy input (£800, "about a grand") | parsed correctly |

---

## Summary

| Item | Status | Commit | Before Conv | After Conv |
|---|---|---|---|---|
| Config (daetradez threshold=1000) | ✅ Done | one-off script | — | — |
| Item 1 — Marcus third-person leak | ✅ Done | `af31e08` | `cmr3avz2x002ilb04dbfih5j5` | `cmr4t4kxu0003l504ktp4okhb` |
| Item 2 — Deep-why context loss | ✅ Done | `af31e08` | `cmr3avz2x002ilb04dbfih5j5` | `cmr4t4kxu0003l504ktp4okhb` |
| Item 3 — R24 six-path test | ⏳ Ali's | — | — | — |
