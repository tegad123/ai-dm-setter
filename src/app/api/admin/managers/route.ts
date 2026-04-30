import prisma from '@/lib/prisma';
import { requireSuperAdmin, AuthError } from '@/lib/auth-guard';
import { sendEmail } from '@/lib/email-notifier';
import { NextRequest, NextResponse } from 'next/server';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireSuperAdmin(request);
    const body = await request.json().catch(() => ({}));
    const email = String(body?.email ?? '')
      .trim()
      .toLowerCase();
    const name = String(body?.name ?? '').trim() || email.split('@')[0];

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json(
        { error: 'Valid manager email is required.' },
        { status: 400 }
      );
    }

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true, isActive: true }
    });
    if (existing && existing.role !== 'MANAGER') {
      return NextResponse.json(
        { error: `${email} already exists with role ${existing.role}.` },
        { status: 409 }
      );
    }

    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { name, role: 'MANAGER', isActive: existing.isActive }
      });
    } else {
      await prisma.user.create({
        data: {
          accountId: auth.accountId,
          email,
          name,
          passwordHash: '',
          role: 'MANAGER',
          isActive: false
        }
      });
    }

    await prisma.adminLog.create({
      data: {
        adminUserId: auth.userId,
        action: 'manager.invite',
        metadata: { email, name }
      }
    });

    const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://qualifydms.io';
    const inviteUrl = `${origin.replace(/\/$/, '')}/auth/sign-up?email=${encodeURIComponent(email)}&role=manager`;
    const inviteEmail = await sendEmail({
      to: email,
      subject: 'You were invited to manage QualifyDMs client accounts',
      text: `Hey ${name},

You were invited to QualifyDMs as a manager.

Accept the invite here: ${inviteUrl}

Use this email address (${email}) when you sign up so the invite attaches to your manager role.

QualifyDMs`
    });

    return NextResponse.json({
      ok: true,
      inviteUrl,
      emailSent: inviteEmail.ok,
      emailError: inviteEmail.error ?? inviteEmail.skipped ?? null
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[admin/managers] error:', err);
    return NextResponse.json(
      { error: 'Failed to create manager invite.' },
      { status: 500 }
    );
  }
}
