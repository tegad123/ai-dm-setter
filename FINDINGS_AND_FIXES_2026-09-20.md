# ManyChat Instagram findings and repair handoff

Updated 2026-09-20. Status: OPEN. This document supersedes conflicting conclusions in AUDIT.md, MORNING.md, and the chat. It summarizes recorded observations, not a fresh production/deployment certification.

## Outcome

Convlo can receive Instagram messages and has persisted AI outbound message IDs. The remaining first-reply problem is suspected to involve ManyChat callback execution, contact identity matching, or context attachment. The exact failure boundary is not yet proven for a matched natural follower. It is incorrect to declare the entire AI pipeline healthy or the missing callback the sole cause from aggregate counts.

Correct production workspace: Daniel Elumelu's Workspace, account `cmpy59zy50000ju04u6fs5o2r`. ManyChat workspace: `fb2940357`.

## Findings and evidence limits

| Observation | What it establishes | What remains unproven |
| --- | --- | --- |
| Live follower flow called the context endpoint before the special Opening DM and originally omitted the first-reply tag. Default Reply required that tag. | A configuration gap prevented untagged contacts from taking that callback branch. Pre-send context is not delivery proof. | Whether a particular natural follower took the corrected branch. |
| Controlled contact `@tefeo.444`, subscriber `360134116`, reached Default Reply; External Request metrics showed one execution, acceptance success action zero, and no receipt was found. | Controlled handoff acceptance was not established. The failed branch was silent. | Actual HTTP status/body, runtime payload, authentication result, intake pause state and request logs. Metrics alone do not prove the endpoint received the request. |
| Fresh test accounts showed no opener during observation and exact-handle searches initially found no contact. | No successful opener/handoff proof in those observations. | Permanent event loss, restrictions, new-account filtering, or deduplication. A later ManyChat list DID show `convlo.pipeline.test926`, contradicting a permanent no-contact conclusion. Final `qa0926` observation did not separately verify Requests. |
| New Instagram records in Daniel's workspace included conversations labeled MANYCHAT. | Convlo stored ManyChat-attributed context. | Actual opener delivery, natural-follower identity for every row, or successful first-reply processing. |
| A four-hour query returned 52 LEAD message rows, all in INBOUND conversations with no stored ManyChat opener/trigger. | Those queried rows lacked the selected context fields. | 52 distinct people, or proof that all had entered ManyChat. Match subscriber and native Instagram IDs first. |
| 43 of those inbound rows belonged to conversations with an AI message carrying a Meta ID or confirmation status somewhere in the same window. | Some AI send evidence exists in those conversations. | 43 unique delivered responses, or that an AI message followed each specific lead message. The query did not enforce chronology or deduplicate conversations. |
| Earlier receipt checks returned zero within their windows. | No receipt was found in those checks. | Zero receipts for the complete incident or each of the 52 rows; the latest context query did not join receipts. |

## Changes already made

1. Prior release documentation records durable queued first-reply intake (PR #49, `cabaeda158a81787a28503f2bc814eb17868853b`) and planned-opener display correction (PR #50, `c962f780e7e4b3dd85391e0fa6bdeeaf81fe1c2c`). These are historical deployment records; current production revision must be checked before further deployment.
2. User-approved live ManyChat change on September 19: `Say hi to new followers` (`content20260525175153_800301`) adds `Convlo - Awaiting first reply` after its context External Request and before the special Instagram opener. Published state was observed. Evidence commit `4b77b94`.
3. Default Reply (`content20260918151817_348241`) was observed using `processingMode: queued_first_reply`, `scheduleAi:true`, lead response text, and `$.handoffAccepted` mapping. The field resets to No; tag removal requires true.
4. The general follower tag addition expands eligibility for the existing queued callback beyond manually tagged test contacts. This is a rollout change, not merely a test repair. Full production closure proof was still missing when it was applied.
5. Monitor workspace scope was corrected after it incorrectly queried an account by Daetradez name/slug. Previous zero-activity reports were invalid for Daniel's workspace.

No application changes or historical replays are made by this documentation update. No credentials belong in these documents.

## Work required and owners

### Tega / ManyChat and Meta access

- Select one naturally replying follower visible in both systems. Record ManyChat subscriber ID, native Instagram recipient ID, Convlo lead/conversation ID, automation version, and UTC timestamps. Do not match by display name alone or interact with the lead.
- Inspect that contact's flow execution: trigger, opener attempt, tag assignment, Default Reply condition, actual external request, response status/body, acceptance-field value, and tag-removal outcome. Redact keys.
- Verify the correct native variables populate subscriber, username, recipient and first-answer fields. A ManyChat contact ID must not be assumed to be a native Instagram ID; document where resolution occurs.
- Preserve the early callback as planned context for the special terminal Opening DM. Do not claim it confirms delivery or instruct a post-send step that the builder cannot support.
- Add an explicit operator-visible failure branch for unsuccessful callback acceptance after its behavior is reviewed. Keep context/tag available for diagnosis. Do not blindly resend a first answer or repeatedly retry a permanent failure.
- Change routing only if a matched send error and ownership evidence require it. Account restriction and fresh-account filtering explanations remain hypotheses.

### Shazim / integration code and runtime evidence

- Correlate the exact ManyChat request with production intake logs. Check auth, payload validation, pause state, receipt conflict and database/runtime errors. Capture sanitized status and request correlation evidence.
- If intake accepted, trace receipt to conversation, messages, worker lease/status and scheduled job. If no receipt exists, identify the rejection before changing worker or engine behavior.
- Compare opener-context identity with native inbound identity. Investigate split conversations where a MANYCHAT context record and an INBOUND reply record represent the same verified native recipient. Repair only if demonstrated; do not merge on name or assumed username equivalence.
- If callbacks and native events race, preserve context on the canonical conversation and reuse inbound/scheduled work. Require duplicate-prevention tests before deployment.
- Keep planned/provider-reported/Meta-confirmed opener states distinct. Preserve actual Meta IDs and error codes. A stored opener or HTTP 200 is not delivery proof.
- Own remaining script progression and no-delivery engine cases separately. Verify the selected branch, suppression reason, hold and actual outbound chronology. This handoff investigation does not establish that those cases are resolved.
- Historical failed messages require their own eligibility review (window, ownership, prior outbound, existing jobs and holds). Never auto-replay them as part of this repair.

Shazim does not need Meta Business Suite access for his tasks. Tega supplies the configuration and contact execution evidence.

## Monitor corrections still required

The monitor must use the exact account ID, cover the interval since its last successful check (not only 30 minutes when runs are hours apart), and include new messages in older conversations. It must deduplicate by conversation and inbound message ID, then link later outbound evidence to the particular reply/job. Separate Instagram jobs from Facebook jobs. Examine failed scheduled work and holds directly; absence of failed AI message rows is not absence of failure.

Do not flag all INBOUND conversations as broken handoffs. Establish ManyChat origin using matching subscriber/native IDs first. Report inability to inspect ManyChat as a coverage gap, not absence of a trigger. Store a bounded checkpoint/evidence record so repeated runs do not create conflicting counts.

## Closure requirements

For the same verified follower, retain:

1. ManyChat flow execution and subscriber/native identity correlation.
2. Opener provider evidence and, when available, persisted native Meta ID. Otherwise label delivery unverified; never infer it from a context bubble.
3. First inbound reply ID/time and exact callback status.
4. Durable accepted receipt linked to the same conversation, or a documented alternate path that does not masquerade as queued-handoff proof.
5. One reply operation with native-webhook/callback duplicate reconciliation.
6. Later AI outbound with persisted Meta ID, matching the expected script branch.
7. Subsequent inbound/outbound proving normal continuation.
8. Preserved AI-off, generate-only, review/distress holds, terminal failures and messaging-window behavior.

Natural read-only observations can prove the observed path. They cannot by themselves prove the controlled concurrent-arrival test. Do not declare full recovery until required concurrency and delivery checks have separate evidence.

## Next concrete action

Stop waiting for generic activity. Match one of the natural followers Tega already sees replying across ManyChat and Convlo, and obtain the exact callback outcome. That determines whether the repair belongs in ManyChat execution/configuration, intake validation/authentication, identity/context reconciliation, or downstream processing. Current evidence does not justify choosing one blindly.
