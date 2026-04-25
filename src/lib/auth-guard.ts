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
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      accountId: true,
      isActive: true
    }
  });

  // Pending invite claim. If a user row exists but is inactive, an admin
  // invited this email via POST /api/team/invite earlier. Flip the row
  // to active + sync the name from Clerk so the invitee lands in their
  // intended workspace instead of getting auto-provisioned a fresh
  // empty account.
  if (dbUser && dbUser.isActive === false) {
    await prisma.user.update({
      where: { id: dbUser.id },
      data: { isActive: true, name }
    });
    dbUser = { ...dbUser, name, isActive: true };
    console.log(
      `[auth-guard] claimed pending invite for ${email} → account ${dbUser.accountId} (role=${dbUser.role})`
    );
  }

  // Auto-provision: if no user exists, create a fresh account + user
  if (!dbUser) {
    // Generate a unique slug from the email prefix
    const baseSlug = email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    let slug = baseSlug;
    let slugSuffix = 0;

    // Ensure slug uniqueness
    while (await prisma.account.findUnique({ where: { slug } })) {
      slugSuffix++;
      slug = `${baseSlug}-${slugSuffix}`;
    }

    // Always create a new account — each user gets their own fresh workspace
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          name: name + "'s Workspace",
          slug
        }
      });

      // Create a default AI persona for the new account
      const systemPrompt = `You are ${name}. You're messaging a lead who showed interest in your services. Your job is to qualify them and book a call. Be conversational and authentic — talk like a real person, not a bot.`;

      await tx.aIPersona.create({
        data: {
          accountId: account.id,
          personaName: `Sales ${name.split(' ')[0]}`,
          fullName: name,
          tone: 'casual, direct, friendly',
          systemPrompt
        }
      });

      const user = await tx.user.create({
        data: {
          name,
          email,
          passwordHash: '', // Clerk manages passwords
          role: 'ADMIN',
          accountId: account.id
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          accountId: true,
          isActive: true
        }
      });

      return user;
    });

    dbUser = result;
  }

  if (!dbUser) {
    throw new AuthError('User provisioning failed', 500);
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
