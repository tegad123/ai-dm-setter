# Morning packet — 2026-09-19

## 1. Current result

The new-follower test using `@tefeo.444` is **ambiguous**, not a Convlo failure. The account follows Daetradez, but it had no Instagram opener, no Message Request, and no ManyChat contact record. The event stopped before ManyChat created evidence for Convlo to receive.

## 2. Completed code release

Production reports commit `c485a0f070436cfd1e836e3a195471f5f51db259`.

- Rejects a Facebook queued handoff when it lacks a recipient identity instead of matching a same-named person.
- Stops retrying permanent Meta delivery rejections.
- Creates an operator-visible terminal scheduled-delivery failure.
- Stops pricing/product questions containing a dollar amount from incorrectly advancing the script.

Validation before deployment: targeted reliability tests passed, ManyChat receipt integration passed locally, TypeScript and production build passed. Production has not yet supplied a live ManyChat receipt-to-Meta-message-ID proof.

## 3. Proposed ManyChat change — not applied

Add `Convlo - Awaiting first reply` to the **published new-follower flow** before the special Opening DM. It connects a real opener response to the Default Reply flow’s queued-first-reply callback.

Do not apply this to general traffic until one tagged test contact proves: visible opener, one receipt, one scheduled reply, a persisted Meta message ID, and correct second-turn routing.

## 4. Safe controlled test

Use `@tefeo.444`, no additional Instagram account:

1. Send a single test inbound to open a window and create its ManyChat contact.
2. Add the tag only to that contact.
3. Send a second test reply.
4. Inspect receipt, scheduler, Meta delivery ID, and script continuation.

The required send was prepared but not sent pending Tega’s confirmation. No message was sent and no contact tag was added.

## 5. Still open

- The precise upstream reason new accounts do not become ManyChat contacts for follow-to-DM.
- A fresh physical opener proof from an established account or an eligible account with a per-contact ManyChat record.
- A full queued-first-reply production proof.
- Historical Meta ownership failures remain historical recovery work; they were not replayed.

## 6. Boundaries honored

No live ManyChat flow was edited, paused, republished, or reordered. No Meta routing, permissions, subscriptions, credentials, or production conversation rows were changed. No real lead was contacted.
