# Held-Conversation Backlog Triage — daetradez (2026-08-08)

41 conversations sit in `awaitingHumanReview`. Surfaced by the Action Required
fix (`d3b4321`); invisible before it. NO holds have been released — this is the
prep list awaiting Tega/Daniel's decision (reply manually vs release the hold).

**Operational constraint that shapes every disposition:** Meta messaging
windows. Standard replies allowed only within 24h of the lead's last message;
the human-agent tag extends that to 7 days. Anything older than Aug 1 cannot be
messaged at all until the lead writes again — for those, "release the hold" is
the only meaningful action (AI resumes if the lead ever returns).

## A. ACTIONABLE — lead waiting, within the 7-day window (7)

| Lead | Conv | Held since | Last lead message | Note |
|---|---|---|---|---|
| Kingsley Ese | cmsjild690003ie049oihq8e4 | Aug 7 | "Thanks I appreciate you taking out time to do this." | POST-FIX hold: single-bubble verbatim_repeat exhaustion at step 14 (partial-ship correctly N/A — no clean sibling). Legit hold, panel-visible. |
| Daniel Omiko | cms5bs95t001bl804mj333n8k | Aug 2 | "Ok thank you sir" | |
| Chad Mcauley | cmsc7w607000cla04y1z074qk | Aug 2 | "Can you send me the link please" | PURCHASE INTENT |
| Troy Fullwood | cmsbnrz01000ql204le46ejkg | Aug 2 | "Where's the link" | PURCHASE INTENT |
| Thalente Ngcobo | cmsbh7fcz001el404z49cqp2b | Aug 2 | FOMO/emotions answer | |
| Mzamo Mthethwa | cmsbojt740003jv04oy052b0d | Aug 2 | liquidity answer | |
| Samuel Benjamin | cms0tffbr0007la043uh7u9o0 | Aug 1 | account-size concern | |

Recommended: human reply for the two PURCHASE INTENT leads today (window for
the Aug 2 group closes Aug 9); release the rest so the AI resumes.

## B. DISTRESS HOLDS — human-only, never auto-release (8)

Prf Sam Ochapa (Aug 7 — last msg "How can i afford that", distress flag looks
questionable, review the triggering message), Van Kaal (Aug 5), Zóm Biéé
(Aug 3 — "Pls bro feel my mental problems bro", looks legitimate), Francisko
Matusse (Aug 2), Michael Siviwe Vilane (Jul 30), Oche Joseph (Jul 30 — "I am
very ok and sound"), Harry Sithole (Jul 30, AI spoke last), Seemal Shazim Khan
(Jul 25 — "nvm im good, just send me the link").

Several look like recovered/benign conversations flagged in the pre-fix
distress era. Daniel's judgment call per conversation; distress holds stay
out of any bulk release.

## C. STALE JUL-29 GATE-HOLD CLUSTER — unreachable until lead returns (16)

Thokozani Kunene, Thabo Khumalo, Ubong Samuel Akpan, Felix Dave, Abolade Gold,
Ayoub El, Awuor Mercy, Quana OBryan ("Hello. Following up"), Dandison Opara,
Shayne Granat, Ojale Israel, Nsidifiok Nsukaba, Bitrus Kickx Billy, Thamsanqa
Nhlanhla Moyo, Alex Sam, Kamohelo Futho.

All held Jul 29 (one bad gate day, pre-fix era), all mid-discovery answers,
all past the 7-day window. Recommended: bulk-release the hold so the AI
resumes if any lead returns; nothing else is possible.

## D. AI SPOKE LAST — nothing owed (3)

Terry Touy (Jul 22), Paris Mokoena (Jun 17), "zoom app" lead (Jun 16).
Recommended: release, low priority.

## E. ANCIENT / UNREACHABLE (4)

Nissi Chalnan (Jul 23 — asked "When are you available for a conversation"),
Steven Biggam (Jun 7, CALL_PROPOSED), Jus Zane (Jun 5), Daúd Zulficar Rugnate
(Jun 4). Past every window. Recommended: release-and-wait or close out.

## F. DELIBERATELY PAUSED — leave alone (3)

Ekene, Professional Noob, Jonathan C Chihuri (all `aiActive=false`, Jun 4).
Human paused these on purpose; not part of this cleanup.
