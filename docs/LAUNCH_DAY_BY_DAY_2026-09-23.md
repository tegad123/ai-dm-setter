# Convlo launch: working plan

Prepared 2026-09-23 from the Pre-Launch QA and Developer Handoff and Tega's
launch timeline. Dates are targets until Tega confirms the sequence. The
browser checklist and canonical task states live in `docs/launch-tracker.json`.

## Release rule

Engineering delivers P0 evidence by 1 October, Tega verifies by 2 October,
5 October is the buffer, and Daniel starts client-one outreach on 6 October
only after sign-off. If P0.0 cannot be closed by 25 September, move the date
rather than reducing the acceptance standard.

| Date   | Engineering focus                                                                                                                                                                                                       | Evidence due / dependency                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 23 Sep | Reconcile deployed P0.0 instrumentation with the exact audit; inspect the seven stored failure causes and the five silent losses read-only. Request ManyChat and Meta access. Prepare FB/IG real-message monitoring.    | Production version, migration presence, original classification output and exact remaining P0.0 gaps.                                       |
| 24 Sep | Finish coded terminal paths, distinguish generation exhaustion from a declared hold, capture pre-claim state and explicit no-generation reasons. Trace ManyChat trigger, opener, contact identity and external request. | Controlled supersession, cancellation, exhaustion, hold and permanent-failure traces; ManyChat failure-boundary evidence.                   |
| 25 Sep | Re-run the September 18–20 classifier and forward tests. Complete P0.1 natural follower chain or make an explicit, approved fallback decision.                                                                          | P0.0 checkpoint with historical gaps disclosed; accepted callback to Meta send, or a documented slip and new date.                          |
| 28 Sep | Resolve P0.12's five silent losses and Step 14 root cause. Finish P0.1 race, replay and direct-inbound regression. Start P0.11 review state and inbox from stable P0.0 data.                                            | Per-job chronology, reproducible cases, visible terminal outcomes, no duplicate reply operation.                                            |
| 29 Sep | Implement and test intent, context, question and clear-interest gates; validate state transitions and stale-write rejection. Continue P0.11 phone flow.                                                                 | Historical case replays plus new controlled turn traces.                                                                                    |
| 30 Sep | Purchase evidence, Step 14, resource URLs and resends. Finish review/resume controls and mobile flow.                                                                                                                   | Correct purchase, link and resend behavior; review approval, edit, hold, steer and idempotency tests.                                       |
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
