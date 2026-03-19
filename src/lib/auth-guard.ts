import { NextRequest } from 'next/server';
import { verifyToken, getTokenFromHeader } from '@/lib/auth';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: string;
  accountId: string;
}

export async function requireAuth(request: NextRequest): Promise<AuthContext> {
  const token = getTokenFromHeader(request.headers.get('authorization'));
  if (!token) throw new AuthError('Authentication required', 401);

  const payload = verifyToken(token);
  if (!payload) throw new AuthError('Invalid or expired token', 401);

  return {
    userId: payload.userId,
    email: payload.email,
    name: payload.name,
    role: payload.role,
    accountId: payload.accountId
  };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}
