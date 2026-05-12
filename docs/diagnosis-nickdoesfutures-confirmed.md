# Confirmed root cause — @nickdoesfutures

## Account state (from DB)

| Field | Value | Verdict |
|---|---|---|
| accountId | `cmosyitmk0000jv04jw87i8hl` | ✓ exists |
| slug | `nickdoesfutures` | ✓ |
| planStatus | `ACTIVE` | ✓ not a gate |
| trainingPhase | `ONBOARDING` | ✓ not a gate |
| INSTAGRAM credential | present, `isActive=true` | ✓ gate at `route.ts:227-237` passes |
| `metadata.igUserId` | `26566938759642516` | ⭐ wrong format for webhook routing |
| `metadata.instagramAccountId` | `26566938759642516` (same value) | ⭐ duplicate, same wrong format |
| `metadata.pageId` | **MISSING** | ⭐ no Facebook page link |
| `metadata.igBusinessAccountId` | **MISSING** | ⭐ THIS is what Meta sends in webhook entry.id |
| AIPersona | 1 row, `isActive: false`, `setupComplete: false` | downstream block (AI won't reply even if lead lands) |
| Leads in DB | **0** | confirms ingestion is dropping upstream |
| ID collisions across accounts | 0 | not the multi-tenant ambiguity case |

## Root cause

**Same OAuth ID-format bug we hit with @daetradez earlier today.**

Meta's IG OAuth (IG Login flow, IGAA tokens) returns two distinct numeric IDs for the same account:
- `26566938759642516` — **IG Login user ID** (what `/me` returns; what we stored)
- `17841…` (some 17841-prefixed ID) — **IG Business Account ID** (what `/conversations` participants return; what Meta puts in `entry.id` of inbound webhooks)

The webhook handler at `src/app/api/webhooks/instagram/route.ts:180-187` checks all four metadata keys:
```
meta?.pageId === entryId || meta?.igUserId === entryId ||
meta?.instagramAccountId === entryId || meta?.igBusinessAccountId === entryId
```

Nick's metadata only has `igUserId=26566…` and `instagramAccountId=26566…` (same value). When Meta delivers a webhook with `entry.id=17841…`, no match → handler logs `[instagram-webhook] No matching account for entry.id=…` → drops with 200 OK → no lead row.

Verified by:
- 0 leads in DB for this account
- No multi-tenant collision (only 1 account has `26566938759642516` in any metadata field)
- The `INSTAGRAM` credential gate at L227-237 would not be the cause — it'd only fire IF the entry.id matched. The earlier match step at L180-187 is where the drop happens.

This matches the Daniel manual-recovery pattern from earlier in this session — fixed there by manually adding `igBusinessAccountId: '17841466787703998'` to the IG credential metadata after probing the conversations API.

## Recommended fix path (need your go-ahead)

### A. Immediate unblock for Nick

1. Call `https://graph.instagram.com/v21.0/me/conversations?platform=instagram&fields=participants&access_token=<NICK_IGAA_TOKEN>` to fetch a sample conversation; the `participants[].id` for `nickdoesfutures` will reveal his real IG Business Account ID (the `17841…` value).
2. Patch the credential row's metadata:
   ```js
   metadata.igBusinessAccountId = '17841…'  // resolved value
   ```
3. Activate the persona (`isActive=true`, `setupComplete=true`) OR walk Nick through persona setup so the AI can generate when a lead lands. Otherwise leads will arrive but no AI reply.

### B. Permanent code fix (OAuth callback)

`src/app/api/auth/instagram/callback/route.ts` should ALWAYS resolve and persist `igBusinessAccountId` alongside `igUserId`. Probe the conversations API or `/me?fields=…` with both formats during callback to disambiguate. Without this, every new IG OAuth user lands in this same broken state.

### C. Defensive webhook routing

Add a fallback at `route.ts:155` — when no metadata-key match for `entry.id`, attempt a runtime resolution: for each account with an INSTAGRAM credential, call `getUserProfile(accountId, entryId)` and check whether the profile resolves successfully (proves token can see this account). This recovers from credential-metadata corruption without manual intervention.

## What I'd need to do A

- Confirmation to (a) call Meta API to resolve Nick's igBusinessAccountId, (b) write the resolved value to the credential metadata, and (c) flip the persona to active (or have Nick walk through onboarding first).
- The IG OAuth token should already be in the credential row encrypted; nothing else needed from you.
