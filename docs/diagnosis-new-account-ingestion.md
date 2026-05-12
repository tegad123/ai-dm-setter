# Diagnosis — New account: no leads, no AI response

**Date:** 2026-05-06
**Status:** Diagnosis only. No fixes applied.

## Most likely root causes (ranked)

### 1. ⭐ No `provider='INSTAGRAM'` IntegrationCredential, OR metadata IDs don't match Meta's `entry.id`

**Severity:** Almost certainly the issue.

The Instagram webhook handler routes inbound payloads to an account by matching `entry.id` against credential **metadata** keys:

`src/app/api/webhooks/instagram/route.ts:180-187`
```ts
meta?.pageId === entryId ||
meta?.igUserId === entryId ||
meta?.instagramAccountId === entryId ||
meta?.igBusinessAccountId === entryId
```

Then at **L227-237** a hard gate fires:
> // ── Gate: skip if no active INSTAGRAM credential for this account ────
> `[instagram-webhook] No INSTAGRAM credential for account=${accountId}, skipping`

If the new account only has a `META` credential (Facebook OAuth) without a separate `INSTAGRAM` (IGAA) credential, **the webhook is silently dropped** with a `200 OK` to Meta and a `console.warn` server-side. Lead never created.

**Data to confirm:**
- `SELECT * FROM "IntegrationCredential" WHERE "accountId"='<NEW_ACCOUNT_ID>';` — look for a row with `provider='INSTAGRAM'` and `isActive=true`.
- Vercel logs: search `[instagram-webhook] No INSTAGRAM credential for account=`.
- Vercel logs: search `[instagram-webhook] No matching account for entry.id=` (or similar — exact wording at L155-160).

---

### 2. Multi-tenant ambiguity skip

`src/app/api/webhooks/instagram/route.ts:206-218` — when MULTIPLE accounts match the same `entry.id`, the handler rejects the payload entirely (skip + alert) rather than picking the "oldest". If the new account's IG metadata overlaps with an existing account (e.g., same `pageId` because OAuth wasn't fully scoped, or both linked to the same FB Page), neither gets the message.

**Data to confirm:**
- Count credentials matching the new account's IG ID:
  `SELECT "accountId", provider, metadata FROM "IntegrationCredential" WHERE metadata::jsonb->>'igUserId' = '<NEW_IG_ID>' OR metadata::jsonb->>'instagramAccountId' = '<NEW_IG_ID>';`
- Vercel logs: `[instagram-webhook] Multiple accounts matched entry`.

---

### 3. Active AIPersona missing → generation aborts (lead would still exist)

`src/lib/ai-engine.ts:647`
> `[ai-engine] generateReply: AIPersona ${personaId} not found (caller passed accountId=${accountId})`

If the new account never completed persona setup, `generateReply` aborts AFTER the lead and conversation rows are created. **Lead WOULD still appear in the dashboard.** Since the user reports "no lead appeared," this is likely NOT the primary cause — but it WILL block the AI response even after ingestion is fixed.

**Data to confirm:**
- `SELECT id, "personaName", "isActive" FROM "AIPersona" WHERE "accountId"='<NEW>';`
- `active-persona.ts:28` — uses `findFirst({where:{accountId, isActive:true}})`. Returns null if none.

---

### 4. Dashboard query scope mismatch

`src/app/api/conversations/route.ts:16,24` — `scopedAccountId(auth, searchParams.get('accountId'))` filters leads by `accountId`. If the dashboard session/URL is still bound to the operator's previous account, leads on the new account won't render even if they exist.

`src/app/api/conversations/route.ts:38-44` — also default-excludes `cold-pitch` tagged leads. New leads are typically untagged so this isn't the issue, but worth noting.

**Data to confirm:**
- Direct DB query: `SELECT id, name, handle, "createdAt" FROM "Lead" WHERE "accountId"='<NEW>' ORDER BY "createdAt" DESC LIMIT 5;` — if rows exist, ingestion is fine and the dashboard scope is the issue.
- Inspect dashboard URL — does it have `?accountId=<NEW_ACCOUNT_ID>`? `scopedAccountId` falls back to the auth context's account when the param is missing.

---

### 5. AI default-off policy (NEW: 2026-05-06)

Even after ingestion succeeds, `aiActive` defaults to `false` for all new conversations (commit `2764a2d`, schema migration `20260506170000_aiactive_default_false`). The lead WILL appear in dashboard, but no AI reply until operator toggles AI on.

This is intentional and operator-controlled. Not the cause of the reported "no lead appeared" — included for completeness.

---

## What's NOT a cause

- **No `isOnboarded` / `webhookEnabled` Account field exists.** No allowlist/activation flag in the model.
- `Account.planStatus` defaults `ACTIVE` — not gating webhooks.
- `Account.healthStatus` is read-only telemetry, doesn't gate ingestion.
- `Account.distressDetectionEnabled` runs AFTER lead creation, can't drop the message.
- `voice-quality-gate.ts` runs on outbound, never inbound.

---

## Recommended verification order

1. **Check IntegrationCredential rows for the new account** — fastest test, catches case 1+2.
2. **Check Vercel logs for `[instagram-webhook]` warnings** — exposes which gate fired.
3. **Direct-query Lead table** — distinguishes ingestion failure (no rows) from dashboard-scope issue (rows exist but invisible).
4. **Check AIPersona rows** — confirms whether AI generation can proceed once ingestion is fixed.

---

## Files referenced

| File | Lines | What it does |
|---|---|---|
| `src/app/api/webhooks/instagram/route.ts` | 115-118 | Signature verification |
| `src/app/api/webhooks/instagram/route.ts` | 180-218 | Account routing by entry.id metadata match + multi-match skip |
| `src/app/api/webhooks/instagram/route.ts` | 227-237 | Hard gate: skip if no active INSTAGRAM credential |
| `src/lib/credential-store.ts` | 248-271 | `getMetaPageId` / `getCredentials` — all filter `isActive: true` |
| `src/lib/ai-engine.ts` | 647 | Persona-not-found abort |
| `src/lib/active-persona.ts` | 28 | `findFirst({isActive:true})` — null when no active persona |
| `src/app/api/conversations/route.ts` | 16-24 | Dashboard list filter by scoped accountId |
| `prisma/schema.prisma` (Account) | — | No `isOnboarded` / `webhookEnabled` flag |
