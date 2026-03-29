import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export interface TokenPayload {
  userId: string;
  email: string;
  accountId: string;
  role: string;
}

/**
 * Sign a JWT token for a user.
 */
export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Verify and decode a JWT token. Returns null if invalid/expired.
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Extract the Bearer token from an Authorization header.
 */
export function getTokenFromHeader(
  authHeader: string | null
): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}
