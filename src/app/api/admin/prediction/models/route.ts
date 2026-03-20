import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const models = await prisma.predictionModel.findMany({
      where: { accountId: auth.accountId },
      orderBy: { version: 'desc' },
      take: 20,
      include: {
        _count: {
          select: { predictions: true }
        }
      }
    });

    const modelsWithCount = models.map((model) => ({
      id: model.id,
      accountId: model.accountId,
      version: model.version,
      modelType: model.modelType,
      features: model.features,
      trainingSize: model.trainingSize,
      holdoutSize: model.holdoutSize,
      accuracy: model.accuracy,
      auc: model.auc,
      precision: model.precision,
      recall: model.recall,
      isActive: model.isActive,
      trainedAt: model.trainedAt,
      predictionCount: model._count.predictions
    }));

    return NextResponse.json({ models: modelsWithCount });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/prediction/models error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch prediction models' },
      { status: 500 }
    );
  }
}
