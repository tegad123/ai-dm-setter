import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Meta Deauthorize Callback
// Meta sends a POST here when a user removes the app from their account.
// We revoke stored tokens and deactivate the integration.
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

    console.log(`[deauthorize] User ${userId} removed the app`);

    // Deactivate only the credentials matching this specific Meta user ID
    // Try matching by igUserId first, then by pageId
    const byIgUser = await prisma.integrationCredential.updateMany({
      where: {
        provider: { in: ['META', 'INSTAGRAM'] },
        isActive: true,
        metadata: { path: ['igUserId'], equals: String(userId) }
      },
      data: { isActive: false }
    });

    if (byIgUser.count === 0) {
      // Try matching by pageId
      const byPage = await prisma.integrationCredential.updateMany({
        where: {
          provider: { in: ['META', 'INSTAGRAM'] },
          isActive: true,
          metadata: { path: ['pageId'], equals: String(userId) }
        },
        data: { isActive: false }
      });

      if (byPage.count === 0) {
        // Try matching by instagramAccountId
        await prisma.integrationCredential.updateMany({
          where: {
            provider: { in: ['META', 'INSTAGRAM'] },
            isActive: true,
            metadata: { path: ['instagramAccountId'], equals: String(userId) }
          },
          data: { isActive: false }
        });
      }
    }

    console.log(`[deauthorize] Deactivated credentials for Meta user ${userId}`);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[deauthorize] Error:', err);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
