import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Meta Data Deletion Request Callback
// Meta sends a POST here when a user requests deletion of their data.
// We must return a JSON response with a confirmation_code and a status URL.
// https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
// ---------------------------------------------------------------------------

function parseSignedRequest(signedRequest: string, appSecret: string) {
  const [encodedSig, payload] = signedRequest.split('.');
  const sig = Buffer.from(
    encodedSig.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );
  const expectedSig = crypto
    .createHmac('sha256', appSecret)
    .update(payload)
    .digest();

  if (!crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error('Invalid signature');
  }

  return JSON.parse(
    Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8')
  );
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const signedRequest = formData.get('signed_request') as string;

    if (!signedRequest) {
      return NextResponse.json(
        { error: 'Missing signed_request' },
        { status: 400 }
      );
    }

    const appSecret =
      process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || '';
    const data = parseSignedRequest(signedRequest, appSecret);
    const userId = data.user_id;

    console.log(
      `[data-deletion] Received deletion request for Meta user: ${userId}`
    );

    // Find and deactivate credentials for this user
    const updatedCount = await prisma.integrationCredential.updateMany({
      where: {
        provider: { in: ['META', 'INSTAGRAM'] },
        isActive: true,
        metadata: { path: ['igUserId'], equals: userId }
      },
      data: { isActive: false }
    });

    // Also try matching by pageId
    if (updatedCount.count === 0) {
      await prisma.integrationCredential.updateMany({
        where: {
          provider: { in: ['META', 'INSTAGRAM'] },
          isActive: true,
          metadata: { path: ['pageId'], equals: userId }
        },
        data: { isActive: false }
      });
    }

    // Anonymize leads from this platform user
    await prisma.lead.updateMany({
      where: { platformUserId: userId },
      data: {
        name: '[deleted]',
        platformUserId: `deleted_${userId.slice(-6)}`,
        email: null,
        phone: null
      }
    });

    // Generate a confirmation code
    const confirmationCode = crypto.randomUUID();
    const statusUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://dmsetter.com'}/api/meta/data-deletion/status?code=${confirmationCode}`;

    console.log(
      `[data-deletion] Processed deletion for user ${userId}, code: ${confirmationCode}`
    );

    return NextResponse.json({
      url: statusUrl,
      confirmation_code: confirmationCode
    });
  } catch (err) {
    console.error('[data-deletion] Error:', err);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

// Status check endpoint
export async function GET(request: NextRequest) {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }
  return NextResponse.json({
    status: 'complete',
    confirmation_code: code,
    message: 'Your data has been deleted from DMsetter.'
  });
}
