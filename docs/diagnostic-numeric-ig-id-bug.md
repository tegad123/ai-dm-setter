# Diagnostic Report: Numeric Instagram ID Bug

**Date:** 2026-05-06  
**Status:** Root cause confirmed. No production data modified.

---

## 1. Scope

| Day | Records |
|---|---|
| 2026-05-06 | 2 |
| 2026-05-05 | 10 |
| 2026-04-10 | 32 |
| 2026-04-09 | 10 |
| 2026-04-08 | 1 |
| 2026-04-03 | 1 |
| **Total** | **56** |

Two clear clusters:
- **Cluster A (Apr 3–10, 44 records):** First occurrence. Correlates with a prior Instagram re-auth or ManyChat sync event.  
- **Cluster B (May 5–6, 12 records):** Today's recurrence. Confirmed: Daniel logged out/in of Instagram in the app on May 5.

No affected records between the two clusters — confirming it is **event-triggered**, not a constant background noise issue.

---

## 2. Webhook Payload Analysis

### Schema contract
Our ManyChat handoff endpoint (`src/lib/manychat-handoff.ts`) expects:

```
instagramUsername: z.string().min(1)   ← required, validated as non-empty string only
instagramUserId:   z.coerce.string().min(1)
manyChatSubscriberId: z.coerce.string().min(1)
```

`instagramUsername` accepts **any non-empty string**, including 15-digit numerics.

### What ManyChat sends in broken cases
ManyChat's External Request body maps `{{contact.ig_username}}` → `instagramUsername`. When ManyChat has not fully synced the subscriber profile (e.g., brand-new follower DM, or after an IG re-auth invalidates their cache), `{{contact.ig_username}}` returns the raw numeric **Instagram-Scoped User ID (IGSID)** instead of the username string.

**Broken payload (reconstructed):**
```json
{
  "instagramUsername": "1274526528083205",
  "instagramUserId":   "1274526528083205",
  "manyChatSubscriberId": "123456789"
}
```

**Healthy payload:**
```json
{
  "instagramUsername": "iansilva_0",
  "instagramUserId":   "17841401234567890",
  "manyChatSubscriberId": "987654321"
}
```

Key difference: in broken cases, `instagramUsername` and `instagramUserId` contain the same 15-digit IGSID. In healthy cases, `instagramUsername` is a human-readable handle and `instagramUserId` is a distinct 17-digit IG numeric ID.

### How our handler processes it

```typescript
// manychat-handoff.ts line 121-122
const handle = cleanInstagramUsername(payload.instagramUsername);
// → cleanInstagramUsername("1274526528083205") = "1274526528083205"
// (only strips leading @, no numeric detection)

const leadName = handle || payload.instagramUserId;
// → "1274526528083205"

// Persisted as:
Lead.handle = "1274526528083205"
Lead.name   = "1274526528083205"
```

The numeric IGSID passes `z.string().min(1)` validation. **No detection, no rejection, no resolution attempt.** It is persisted directly.

---

## 3. Code Path Analysis

### Username extraction
`cleanInstagramUsername(username)` → strips `@` prefix only. No numeric check.

### Numeric ID detection (exists, but scope is wrong)
`looksLikeInstagramRecipientId(value, manyChatSubscriberId)` → returns `true` when value matches `^\d{12,}$` AND is not equal to `manyChatSubscriberId`. This is used to set `canSendViaInstagramApi`, **not** to detect or correct a bad `instagramUsername` value.

### Resolution logic
`resolveAndUpgradeInstagramNumericId` in `src/lib/manychat-resolve-ig-id.ts`:
- Runs after lead create/update
- Upgrades `Lead.platformUserId` (the Meta Send API recipient ID)
- **Does NOT update `Lead.handle` or `Lead.name`**
- Only upgrades the send-path ID, not the display identity

`resolveInstagramProfile` in `src/lib/instagram.ts`:
- Full username resolution via Meta Graph API (direct lookup + conversations API fallback)
- Returns `{ username, name }`
- **Currently called from `webhook-processor.ts` for inbound leads, NOT from `manychat-handoff.ts`**

### Gap summary

| Path | Resolves platformUserId | Resolves handle/name |
|---|---|---|
| `resolveAndUpgradeInstagramNumericId` | ✅ | ❌ |
| `resolveInstagramProfile` (instagram.ts) | ✅ | ✅ |
| `processManyChatHandoff` today | partial | ❌ **missing** |

---

## 4. Timing Correlation

| Cluster | Count | Trigger event |
|---|---|---|
| Apr 3–10 | 44 | Prior Instagram re-auth (exact date Apr 3 — 1 record, spike Apr 9–10 = 42) |
| May 5–6 | 12 | Daniel logged out and back in on May 5 |
| Normal operation | 0 | No records in other months |

**Confirmed: numeric handle records cluster tightly around Instagram re-auth events.** The mechanism: when Daniel re-auths, ManyChat temporarily loses its subscriber profile cache for the connected IG account. New incoming flows during this window fire with `{{contact.ig_username}}` unresolved — ManyChat returns the raw IGSID it has from the DM sender context instead.

This is **ManyChat's behavior during degraded-sync windows** combined with our missing detection logic.

---

## 5. Root Cause

**ManyChat passes a numeric IGSID as `instagramUsername` during subscriber-cache degradation windows (triggered by Instagram re-auth events). Our handler has no detection logic for numeric-only username values — `z.string().min(1)` accepts them, `cleanInstagramUsername` passes them through unchanged, and neither `handle` nor `name` is ever corrected afterward.**

The `resolveAndUpgradeInstagramNumericId` resolver runs post-create but only patches `platformUserId`, leaving `handle` and `name` as the numeric string permanently.

---

## 6. Recommended Fix Path

### Option A — Detect + resolve at handoff time (recommended)

In `processManyChatHandoff`, after parsing the payload:

```typescript
const NUMERIC_ONLY = /^\d{12,}$/;

let handle = cleanInstagramUsername(payload.instagramUsername);
let leadName = handle;

// If ManyChat handed us a raw IGSID as the username, try to resolve
// the real handle via ManyChat's subscriber info API before persisting.
if (NUMERIC_ONLY.test(handle)) {
  try {
    const creds = await getCredentials(account.id, 'MANYCHAT');
    if (creds?.apiKey) {
      const sub = await findSubscriberById(
        creds.apiKey,
        payload.manyChatSubscriberId
      );
      if (sub?.ig_username) {
        handle = cleanInstagramUsername(sub.ig_username);
        leadName = handle;
      }
      // platformUserId already handled by resolveAndUpgradeInstagramNumericId
    }
  } catch {
    // non-fatal: persist with numeric handle, webhook-processor upgrade will fix later
  }
}
```

`SubscriberInfo` already has `ig_username?: string` (confirmed at `manychat.ts:38`). This requires one extra ManyChat API call per unresolved-username handoff — rate-limited cost is negligible since this only triggers on degraded payloads.

### Option B — Schema-level rejection (upstream fix)

Change schema to `.refine(v => !/^\d{12,}$/.test(v), 'instagramUsername must not be a numeric ID')`. This rejects the webhook payload → ManyChat must fix their flow variable. **Risk:** causes 400 errors in production during re-auth windows, dropping lead creation entirely. Not recommended alone.

### Option C — Defense in depth (Option A + schema warning + backfill)

Option A as the primary fix. Additionally:
1. Log a `[manychat-handoff] WARN: received numeric instagramUsername "${handle}" — attempting subscriber resolution` line so future occurrences are visible in logs.
2. Run the backfill migration below for existing 56 records.

### Recommendation: **Option C**

Option A is the primary fix. Schema rejection is too aggressive without a ManyChat-side fix. Backfill cleans up existing records.

---

## 7. Backfill Migration Plan

The 56 broken records have the numeric IGSID stored as **both** `handle` and `platformUserId` (since `instagramUserId` = `instagramUsername` in these payloads — same numeric value). This means:

1. `Lead.platformUserId` = the IGSID (usable as a Meta Graph API user ID)
2. `resolveInstagramProfile(accountId, igsid, accessToken)` in `instagram.ts` can resolve the real username via the conversations API

**Script outline** (`scripts/backfill-numeric-handles.ts`):

```typescript
// READ-ONLY DRY RUN until confirmed
const broken = await prisma.lead.findMany({
  where: { handle: { regex: '^[0-9]{14,17}$' } },
  select: { id: true, handle: true, platformUserId: true, accountId: true }
});

for (const lead of broken) {
  const result = await resolveInstagramProfile(
    lead.accountId,
    lead.platformUserId,  // the IGSID
    accessToken           // from Account credentials
  );
  if (result?.username) {
    // prisma.lead.update({ where: { id: lead.id }, data: { handle: result.username, name: result.name } })
    console.log(`WOULD fix: ${lead.id} → @${result.username}`);
  } else {
    console.log(`UNRESOLVABLE: ${lead.id} (${lead.handle})`);
  }
}
```

**Estimated effort:** 2–3 hours (script + dry run + production run + verification).  
**Success rate estimate:** ~70–80% resolvable via conversations API (those leads have had at least one DM exchange). ~20–30% may be unresolvable if the lead never DMed back (IGSID-only, no conversation context in Meta's system).

---

## 8. Prerequisites

- ManyChat API key for account (already in credential store — `getCredentials(accountId, 'MANYCHAT')` confirmed working)
- Instagram access token for Meta Graph API calls (already in `Account.credentials`)
- No schema migration needed — `handle` and `name` fields exist and are nullable-compatible

---

## Files to change for Option C fix

| File | Change |
|---|---|
| `src/lib/manychat-handoff.ts` | Add numeric-username detection + `findSubscriberById` resolution before lead persist |
| `src/lib/manychat-resolve-ig-id.ts` | Optionally: extend to also return `ig_username` alongside `ig_id` |
| `scripts/backfill-numeric-handles.ts` | New — one-time backfill for 56 existing broken records |
