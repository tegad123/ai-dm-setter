import { auth, currentUser } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: string;
  accountId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requireAuth(_request?: any): Promise<AuthContext> {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    throw new AuthError('Authentication required', 401);
  }

  // Look up user by email (Clerk manages the user, we map to our DB)
  const clerkUser = await currentUser();
  if (!clerkUser) {
    throw new AuthError('User not found', 401);
  }

  const email = clerkUser.emailAddresses?.[0]?.emailAddress ?? '';
  const name =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
    clerkUser.username ||
    'User';

  // Find existing user in our DB by email
  let dbUser = await prisma.user.findFirst({
    where: { email },
    select: { id: true, name: true, email: true, role: true, accountId: true }
  });

  // Auto-provision: if no user exists, create account + user
  if (!dbUser) {
    // Check if there's an existing account we should attach to
    // For now, find the first account (single-tenant dev mode)
    let account = await prisma.account.findFirst({
      select: { id: true }
    });

    if (!account) {
      // Create a new account
      account = await prisma.account.create({
        data: {
          name: name + "'s Workspace",
          slug: email.split('@')[0]
        }
      });
    }

    dbUser = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: '', // Clerk manages passwords
        role: 'ADMIN',
        accountId: account.id
      },
      select: { id: true, name: true, email: true, role: true, accountId: true }
    });
  }

  return {
    userId: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role,
    accountId: dbUser.accountId
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
