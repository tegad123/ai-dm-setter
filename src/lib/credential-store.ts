import prisma from '@/lib/prisma';
import crypto from 'crypto';

const ENCRYPTION_KEY =
  process.env.CREDENTIAL_ENCRYPTION_KEY || 'dev-key-change-in-production-32ch';

// Ensure key is 32 bytes for AES-256
function getKey(): Buffer {
  const key = ENCRYPTION_KEY;
  if (key.length >= 32) return Buffer.from(key.slice(0, 32));
  return Buffer.from(key.padEnd(32, '0'));
}

export function encryptCredentials(data: Record<string, string>): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptCredentials(encrypted: string): Record<string, string> {
  const [ivHex, authTagHex, data] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// IntegrationProvider type matches Prisma enum
type Provider =
  | 'META'
  | 'ELEVENLABS'
  | 'LEADCONNECTOR'
  | 'OPENAI'
  | 'ANTHROPIC'
  | 'CALENDLY'
  | 'CALCOM';

export async function getCredentials(
  accountId: string,
  provider: Provider
): Promise<Record<string, string> | null> {
  const cred = await prisma.integrationCredential.findFirst({
    where: { accountId, provider, isActive: true }
  });
  if (!cred) return null;
  try {
    const raw = cred.credentials as any;
    // If it's a string, it's encrypted; if object, it was stored in dev mode
    if (typeof raw === 'string') return decryptCredentials(raw);
    return raw as Record<string, string>;
  } catch {
    return null;
  }
}

export async function saveCredentials(
  accountId: string,
  provider: Provider,
  credentials: Record<string, string>,
  metadata?: Record<string, string>
): Promise<void> {
  const encrypted = encryptCredentials(credentials);
  await prisma.integrationCredential.upsert({
    where: { accountId_provider: { accountId, provider } },
    create: {
      accountId,
      provider,
      credentials: encrypted as any,
      metadata: metadata || {},
      isActive: true,
      verifiedAt: new Date()
    },
    update: {
      credentials: encrypted as any,
      metadata: metadata ? metadata : undefined,
      isActive: true,
      verifiedAt: new Date()
    }
  });
}

export async function deleteCredentials(
  accountId: string,
  provider: Provider
): Promise<void> {
  await prisma.integrationCredential.deleteMany({
    where: { accountId, provider }
  });
}
