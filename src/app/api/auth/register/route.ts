import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { hashPassword, signToken } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const { name, email, password, businessName } = await request.json();

    if (!name || !email || !password || !businessName) {
      return NextResponse.json(
        { error: 'Name, email, password, and businessName are required' },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (existingUser) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);
    const slug = businessName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    const systemPrompt = `You are ${name} from ${businessName}. You're messaging a lead who showed interest in your services. Your job is to qualify them and book a call. Be conversational and authentic — talk like a real person, not a bot.`;

    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          name: businessName,
          slug
        }
      });

      const user = await tx.user.create({
        data: {
          name,
          email: email.toLowerCase(),
          passwordHash,
          role: 'ADMIN',
          accountId: account.id
        }
      });

      await tx.aIPersona.create({
        data: {
          accountId: account.id,
          personaName: `Sales ${name}`,
          fullName: name,
          companyName: businessName,
          tone: 'casual, direct, friendly',
          systemPrompt
        }
      });

      return { account, user };
    });

    const token = signToken({
      userId: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
      accountId: result.account.id
    });

    return NextResponse.json({
      message: 'Account created',
      token,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
        accountId: result.account.id
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
