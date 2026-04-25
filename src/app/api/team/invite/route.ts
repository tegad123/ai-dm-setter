import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { sendEmail } from '@/lib/email-notifier';
import { Role } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST /api/team/invite
// ---------------------------------------------------------------------------
// Admin-only. Creates a placeholder User row attached to the calling
// admin's account with the invitee's email + role + isActive=false. When
// the invitee signs up with Clerk using that same email, auth-guard
// claims the placeholder (flips isActive=true, fills in name) so the
// invitee lands in the existing workspace instead of getting a fresh
// auto-provisioned account.
//
// Sends an invite email via Resend (best-effort) so the invitee gets a
// link without the inviter having to manually copy/paste. The endpoint
// also returns the sign-in URL in the response so the UI can render a
// "copy invite link" button as a fallback when email isn't configured.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ['ADMIN', 'CLOSER', 'SETTER', 'READ_ONLY'] as const;
type ValidRole = (typeof VALID_ROLES)[number];

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can invite team members.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const rawEmail = typeof body?.email === 'string' ? body.email.trim() : '';
    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
    const rawRole = typeof body?.role === 'string' ? body.role : '';

    if (!EMAIL_RE.test(rawEmail)) {
      return NextResponse.json(
        { error: 'Invalid email address.' },
        { status: 400 }
      );
    }
    if (!VALID_ROLES.includes(rawRole as ValidRole)) {
      return NextResponse.json(
        { error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` },
        { status: 400 }
      );
    }
    const email = rawEmail.toLowerCase();
    const role = rawRole as ValidRole;
    const placeholderName = rawName.length > 0 ? rawName : email.split('@')[0];

    // Email is globally unique on User. Reject if already exists.
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, accountId: true, isActive: true }
    });
    if (existing) {
      if (existing.accountId === auth.accountId && !existing.isActive) {
        // Re-invite a previously-invited-but-never-claimed teammate.
        // Refresh role + bounce the email but don't error out.
        await prisma.user.update({
          where: { id: existing.id },
          data: { role: role as Role, name: placeholderName }
        });
      } else if (existing.accountId === auth.accountId && existing.isActive) {
        return NextResponse.json(
          { error: `${email} is already on this team.` },
          { status: 409 }
        );
      } else {
        return NextResponse.json(
          { error: `${email} already has an account elsewhere.` },
          { status: 409 }
        );
      }
    } else {
      await prisma.user.create({
        data: {
          accountId: auth.accountId,
          email,
          name: placeholderName,
          passwordHash: '', // Clerk manages passwords
          role: role as Role,
          isActive: false
        }
      });
    }

    // Build the sign-up link. Invitee signs up at this URL with the
    // invited email; auth-guard claims the placeholder on their first
    // /dashboard hit.
    const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://qualifydms.io';
    const inviteUrl = `${origin.replace(/\/$/, '')}/auth/sign-up?email=${encodeURIComponent(email)}`;

    // Best-effort email — no-ops gracefully if RESEND_API_KEY isn't set.
    const inviteEmail = await sendEmail({
      to: email,
      subject: `${auth.name} invited you to QualifyDMs`,
      text: `Hey,

${auth.name} invited you to their QualifyDMs workspace as a ${role.toLowerCase().replace('_', ' ')}.

Sign up here to accept: ${inviteUrl}

Sign up with this email address (${email}) so the invite gets matched correctly.

—
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
    console.error('[team/invite] error:', err);
    return NextResponse.json(
      { error: 'Failed to create invite.' },
      { status: 500 }
    );
  }
}
