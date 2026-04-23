import prisma from '@/lib/prisma';
import crypto from 'crypto';

const ENCRYPTION_KEY =
  process.env.CREDENTIAL_ENCRYPTION_KEY || 'dev-encryption-key-32-bytes-long!'; // Must be 32 bytes for AES-256

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

// ---------------------------------------------------------------------------
// Encrypt / Decrypt helpers (AES-256-GCM)
// ---------------------------------------------------------------------------

function getKeyBuffer(): Buffer {
  const key = ENCRYPTION_KEY;
  // Ensure exactly 32 bytes
  if (key.length === 32) return Buffer.from(key, 'utf-8');
  return crypto.createHash('sha256').update(key).digest();
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyBuffer(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  // Return iv:tag:ciphertext as hex
  return [
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted.toString('hex')
  ].join(':');
}

export function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Invalid ciphertext format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKeyBuffer(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf-8'
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CredentialData {
  apiKey?: string;
  accessToken?: string;
  model?: string;
  [key: string]: unknown;
}

/**
 * Get decrypted credentials for a provider + account.
 * Returns null if no credential exists or is inactive.
 */
export async function getCredentials(
  accountId: string,
  provider: string
): Promise<CredentialData | null> {
  const record = await prisma.integrationCredential.findFirst({
    where: {
      accountId,
      provider: provider as any,
      isActive: true
    }
  });

  if (!record) return null;

  try {
    const raw = record.credentials as any;
    // If credentials are stored as an encrypted string
    if (typeof raw === 'string') {
      return JSON.parse(decrypt(raw));
    }
    // If stored as a JSON object with encrypted values
    if (raw && typeof raw === 'object') {
      const result: CredentialData = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.includes(':')) {
          try {
            result[key] = decrypt(value);
          } catch {
            result[key] = value; // Not encrypted, use as-is
          }
        } else {
          result[key] = value as any;
        }
      }
      return result;
    }
    return null;
  } catch (err) {
    console.error(
      `[credential-store] Failed to decrypt credentials for ${provider}:`,
      err
    );
    return null;
  }
}

/**
 * Store encrypted credentials for a provider + account.
 */
// Alias for backward compatibility
export const saveCredentials = setCredentials;

export async function setCredentials(
  accountId: string,
  provider: string,
  credentials: CredentialData,
  metadata?: Record<string, unknown>
): Promise<void> {
  // MERGE semantics: load existing record so partial updates (e.g. just
  // calendarId/locationId without re-entering the apiKey) don't wipe
  // previously-saved fields. Callers that want a clean slate should call
  // deleteCredentials() first.
  const existing = await prisma.integrationCredential.findFirst({
    where: {
      accountId,
      provider: provider as any
    }
  });

  // Start from the existing credentials blob (if any). Encrypted fields
  // stay encrypted — we only decrypt on read. New plaintext values get
  // encrypted + overlaid on top.
  const mergedCredentials: Record<string, unknown> = {};
  if (existing?.credentials && typeof existing.credentials === 'object') {
    Object.assign(
      mergedCredentials,
      existing.credentials as Record<string, unknown>
    );
  }
  for (const [key, value] of Object.entries(credentials)) {
    // Skip undefined so callers can omit fields they don't want to touch
    if (value === undefined) continue;
    if (
      typeof value === 'string' &&
      (key === 'apiKey' || key === 'accessToken' || key === 'refreshToken')
    ) {
      mergedCredentials[key] = encrypt(value);
    } else {
      mergedCredentials[key] = value;
    }
  }

  // Same merge semantics for metadata
  const mergedMetadata: Record<string, unknown> = {
    ...((existing?.metadata as Record<string, unknown>) ?? {}),
    ...(metadata ?? {})
  };

  await prisma.integrationCredential.upsert({
    where: {
      accountId_provider: {
        accountId,
        provider: provider as any
      }
    },
    update: {
      credentials: mergedCredentials as any,
      metadata: mergedMetadata as any,
      isActive: true,
      verifiedAt: new Date()
    },
    create: {
      accountId,
      provider: provider as any,
      credentials: mergedCredentials as any,
      metadata: mergedMetadata as any,
      isActive: true,
      verifiedAt: new Date()
    }
  });
}

/**
 * Delete credentials for a provider + account.
 */
export async function deleteCredentials(
  accountId: string,
  provider: string
): Promise<void> {
  await prisma.integrationCredential.deleteMany({
    where: { accountId, provider: provider as any }
  });
}

/**
 * Get the Meta (Facebook/Instagram) access token for an account.
 * Checks per-account credentials first, then falls back to env vars.
 */
export async function getMetaAccessToken(
  accountId: string
): Promise<string | null> {
  // Try per-account META credentials first
  const metaCreds = await getCredentials(accountId, 'META');
  if (metaCreds?.accessToken) return metaCreds.accessToken as string;

  // Try per-account INSTAGRAM credentials
  const igCreds = await getCredentials(accountId, 'INSTAGRAM');
  if (igCreds?.accessToken) return igCreds.accessToken as string;

  // Fallback to env var
  return (
    process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || null
  );
}

/**
 * Returns the Facebook Page ID for this account — used by
 * sendFacebookMessage / sendAudioMessage / getUserProfile's conversations-
 * API fallback. When both META and INSTAGRAM provider rows exist, we
 * MUST prefer META: the INSTAGRAM row's `igUserId` is an IG business
 * account ID, which Meta's `/PAGE_ID/messages` and `/PAGE_ID/conversations`
 * endpoints reject with GraphMethodException 100 subcode 33.
 *
 * Returns in priority order:
 *   1. META credential's `pageId` (correct FB Page ID)
 *   2. INSTAGRAM credential's `igUserId` (legacy fallback for accounts
 *      that only connected IG — the ID won't work for FB sends, but
 *      they don't have an FB page to send to anyway)
 *   3. `FACEBOOK_PAGE_ID` / `INSTAGRAM_PAGE_ID` env var
 *   4. null
 *
 * Previously used a single findFirst over `{META, INSTAGRAM}` with no
 * ordering, which returned whichever row Prisma picked first. On
 * daetradez 2026-04-23 that was INSTAGRAM → FB sends POSTed to the IG
 * biz account ID and 10 ghost AI replies were saved without Meta ever
 * delivering them.
 */
export async function getMetaPageId(accountId: string): Promise<string | null> {
  // 1. META row first — that's the Facebook Page ID
  const metaRecord = await prisma.integrationCredential.findFirst({
    where: { accountId, provider: 'META', isActive: true }
  });
  if (metaRecord?.metadata) {
    const meta = metaRecord.metadata as { pageId?: string };
    if (meta.pageId) return meta.pageId;
  }

  // 2. Fall back to INSTAGRAM only if no META row is configured.
  const igRecord = await prisma.integrationCredential.findFirst({
    where: { accountId, provider: 'INSTAGRAM', isActive: true }
  });
  if (igRecord?.metadata) {
    const igMeta = igRecord.metadata as { igUserId?: string };
    if (igMeta.igUserId) return igMeta.igUserId;
  }

  return process.env.FACEBOOK_PAGE_ID || process.env.INSTAGRAM_PAGE_ID || null;
}
