# Branch eligibility review, 26 September 2026

## Production finding

Production c7e7d9fd658869fe8084babcf3fef506bf730199 delivered the Discord link once through Meta in controlled Instagram conversation cmuimqvun0003ky04pvklz2uw. All four reply jobs finished SENT with DELIVERED reason, claim snapshot and generation trace. See evidence/IG_ROUTING_AFTER_2026-09-26.json.

The flow did not pass: the opening message explicitly named futures, but the Step 1 judge selected “New, no market yet.” Step 4 consequently generated a Forex role instruction. The branch-selection audit and a local provider call reproduced the wrong first branch. This is not a missing webhook or a failed Meta send.

## Change

The router now presents eligibility conditions separately from judgment guidance. Every clause must hold; examples cannot override a failed condition. The Anthropic routing call uses claude-sonnet-4-6 instead of Haiku, with a five-second bound instead of three seconds. Main reply-generation model configuration is unchanged. This increases routing model cost; observed passing benchmark calls remain short. No market-specific selection rule was added. Provider errors still abstain rather than locking a token guess.

Classifier traces now retain an explicit null final selection instead of displaying the discarded lexical guess. Tests cover this distinction.

## Validation

- Same frozen script: cmueln1ns0001l3040lwx9oaf, updated 2026-09-24T03:56:23.516Z.
- Expanded live-provider benchmark: 14/14, including explicit markets combined with beginner status, both markets, adjacent instrument, unknown market, pain, acceptance, refusal and continuation.
- Baseline 8a7e94c on the same 14 fixtures: 10/14. Prompt-only Haiku variants still failed mixed-answer cases; they were not deployed.
- Full unit suite: 911/921, the same 10 pre-existing failures recorded in IG_ANSWER_GATE_REVIEW_2026-09-26.md. TypeScript passed.
- Only Anthropic received a live provider benchmark. No claim of live OpenAI validation.
- Fresh production rerun is pending deployment. This document is not gate closure.

## Test operations and limits

The driver can now continue the existing own-test conversation without resetting. It refuses paused conversations or an unanswered latest inbound. Reset mode remains restricted to @iamshazimkhan. Tests use signed synthetic lead webhooks after a native DM establishes the real messaging window. Meta IDs prove API acceptance; the user still needs to confirm inbox receipt. The last completed test restored reply delay to 0–250 seconds. No other leads, routing settings, ManyChat settings or historical replays were changed.

The browser tracker displays verified active items / all active items, excluding retired requirements. It currently has 0/48 formally accepted items; partial technical evidence is recorded separately and is not counted as completion.
