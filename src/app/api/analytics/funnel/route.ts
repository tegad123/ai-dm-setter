import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const [totalLeads, qualified, booked, showedUp, closed] = await Promise.all(
      [
        prisma.lead.count({ where: { accountId: auth.accountId } }),
        prisma.lead.count({
          where: {
            accountId: auth.accountId,
            stage: {
              in: [
                'QUALIFIED',
                'BOOKED',
                'SHOWED',
                'NO_SHOWED',
                'CLOSED_WON',
                'NURTURE'
              ]
            }
          }
        }),
        prisma.lead.count({
          where: {
            accountId: auth.accountId,
            stage: { in: ['BOOKED', 'SHOWED', 'NO_SHOWED', 'CLOSED_WON'] }
          }
        }),
        prisma.lead.count({
          where: {
            accountId: auth.accountId,
            stage: { in: ['SHOWED', 'CLOSED_WON'] }
          }
        }),
        prisma.lead.count({
          where: { accountId: auth.accountId, stage: 'CLOSED_WON' }
        })
      ]
    );

    return NextResponse.json({
      totalLeads,
      qualified,
      booked,
      showedUp,
      closed
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch funnel data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch funnel data' },
      { status: 500 }
    );
  }
}
