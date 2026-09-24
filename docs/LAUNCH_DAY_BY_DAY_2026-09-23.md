# Convlo launch: working plan

Prepared 2026-09-23 from the Pre-Launch QA and Developer Handoff and Tega's
launch timeline. Dates are targets until Tega confirms the sequence. The
browser checklist and canonical task states live in `docs/launch-tracker.json`.

## 24 September addendum

Tega activated Final Discord Funnel (`cmueln1ns0001l3040lwx9oaf`, seven
steps). `docs/ADDENDUM_A_TRIAGE_2026-09-24.md` retargets the original handoff
and adds A1-A12 to the browser tracker. The old purchase, Step 14, goal and
obstacle criteria are retired for this script, not verified. Keep the Sept 29
and Oct 1 dates as targets only: the new A1/A2/A3/A5 failures need fresh-lead
proof and Tega's sign-off before the active funnel is called ready.

Immediate engineering sequence: snapshot v3 source and version; fix fixed
messages and hard-fail handling (A1/A2); make native inbound to delivered
reply idempotent (A3); tie step completion to delivered parts (A5). Then
instrument discarded generations (A4), reconcile the bounded cursor (A6),
and repair parser judgment loss (A7). Test scripted emoji and punctuation-free
asks (A8/A9) with the first batch because they cause avoidable retries.

## Release rule

Engineering delivers P0 evidence by 1 October, Tega verifies by 2 October,
5 October is the buffer, and Daniel starts client-one outreach on 6 October
only after sign-off. If P0.0 cannot be closed by 25 September, move the date
rather than reducing the acceptance standard.

| Date   | Engineering focus                                                                                                                                                                                                       | Evidence due / dependency                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 23 Sep | Reconcile deployed P0.0 instrumentation with the exact audit; inspect the seven stored failure causes and the five silent losses read-only. Request ManyChat and Meta access. Prepare FB/IG real-message monitoring.    | Production version, migration presence, original classification output and exact remaining P0.0 gaps.                                       |
| 24 Sep | Freeze the v3 source/action snapshot and version. Start A1/A2 fixed-text and hard-fail repair plus A3 one-inbound operation review. Continue P0.0 terminal paths and ManyChat failure-boundary tracing. | Reproducible v3 test cases, code-path map, original trace IDs and checkpoint risk reported. |
| 25 Sep | Test A1/A2/A3 on isolated new leads; begin A5 delivery-driven progression. Re-run the September 18–20 classifier and forward P0.0 tests. Complete P0.1 natural follower chain or document a slip. | No wrong-branch text or duplicate operation, exact hold outcome, P0.0 historical gaps, and accepted callback chain or revised date. |
| 28 Sep | Resolve P0.12's five silent losses, A4 discard reasons and A6 cursor bounds. Finish P0.1 race, replay and direct-inbound regression. Start P0.11 review state and inbox from stable P0.0 data. | Per-job chronology, reproducible cases, visible terminal outcomes, no duplicate reply operation or step overrun. |
| 29 Sep | Implement and test v3 intent, context, question and clear-interest gates. Repair A7 parser judgment loss and A8/A9 script/ask gate mismatches. Continue P0.11 phone flow. | Current v3 source preserved, full judgment actions parsed, historical cases plus new controlled turns. |
| 30 Sep | Validate v3 Discord, Typeform and affiliate resources/resends, plus A10/A11 state and reset behavior. Finish review/resume controls and mobile flow. | Correct links, resend behavior, active-script stages, reset state and phone recovery evidence. |
| 1 Oct  | Run real FB/IG new-lead and continuation proofs where account access and messaging windows permit. Finish monitoring, fault tests and architecture handoff.                                                             | Commit and prod version, script version, conversation/job/trace IDs, Meta IDs, before/after state and observed inbox result for every gate. |
| 2 Oct  | Tega reviews P0 evidence and tests recovery on a phone.                                                                                                                                                                 | Written sign-off or exact open failures.                                                                                                    |
| 5 Oct  | Buffer for fixes and a monitored rollout decision.                                                                                                                                                                      | All P0 checks passed, rollback/pause controls known.                                                                                        |
| 6 Oct  | Daniel approaches client one only after sign-off.                                                                                                                                                                       | Pricing, paperwork, onboarding and success event ready.                                                                                     |

## Inputs needed from Tega

- Invite Shazim to the relevant ManyChat workspace, Meta Business assets and
  developer apps. Do not share passwords.
- Supply the exact automation version, external request configuration, tag
  logic and contact IDs for the isolated Instagram handoff test.
- Approve or reject the direct-webhook fallback before routing changes.
- Approve product facts, free and paid resource URLs, purchase copy and review
  language where the engine needs them.
- Verify each P0 evidence packet, including a real phone recovery.

## Live platform test

Shazim sends a real DM to Daniel's Facebook and Instagram accounts. We use
the natural inbound to prove the 24-hour window and actual delivery. See
`docs/LIVE_FB_IG_E2E_PLAN_2026-09-23.md` for the per-turn checks. Existing
conversations prove continuation; a separate fresh sender is required for
new-lead acceptance. Do not replay or clear existing conversations to make
them look new.

## Current state at plan creation

- `babfae8cd40e7d55c16abd803daa611d65ff4c56` is on production
  `/api/version` and contains P0.0 schema and writer changes.
- The 23 September 24-hour terminal monitor read 207 historical rows with
  labelled reasons and timestamps. None had claim snapshots or trace links;
  forward production evidence remains open.
- ManyChat end-to-end ownership and handoff remain open pending access and a
  controlled chain.
- The ten P1 quality improvements and three deferred product items are tracked
  after the launch gate in `docs/launch-tracker.json`.
