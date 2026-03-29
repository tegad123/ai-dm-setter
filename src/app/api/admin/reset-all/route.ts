import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';

// TEMPORARY: Wipe all accounts and data for a fresh start
// DELETE THIS FILE AFTER USE
export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);

    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    // Delete everything in the correct order (respecting foreign keys)
    const results = await prisma.$transaction(async (tx) => {
      const abTestAssignments = await tx.aBTestAssignment.deleteMany({});
      const abTests = await tx.aBTest.deleteMany({});
      const optimizations = await tx.optimizationSuggestion.deleteMany({});
      const predictionLogs = await tx.predictionLog.deleteMany({});
      const predictionModels = await tx.predictionModel.deleteMany({});
      const promptVersions = await tx.promptVersion.deleteMany({});
      const crmOutcomes = await tx.crmOutcome.deleteMany({});
      const messages = await tx.message.deleteMany({});
      const conversations = await tx.conversation.deleteMany({});
      const leadTags = await tx.leadTag.deleteMany({});
      const teamNotes = await tx.teamNote.deleteMany({});
      const leads = await tx.lead.deleteMany({});
      const notifications = await tx.notification.deleteMany({});
      const tags = await tx.tag.deleteMany({});
      const contentAttributions = await tx.contentAttribution.deleteMany({});
      const trainingExamples = await tx.trainingExample.deleteMany({});
      const integrations = await tx.integrationCredential.deleteMany({});
      const personas = await tx.aIPersona.deleteMany({});
      const users = await tx.user.deleteMany({});
      const accounts = await tx.account.deleteMany({});

      return {
        accounts: accounts.count,
        users: users.count,
        leads: leads.count,
        conversations: conversations.count,
        messages: messages.count,
        notifications: notifications.count,
        personas: personas.count,
        tags: tags.count,
        teamNotes: teamNotes.count,
        trainingExamples: trainingExamples.count,
        integrations: integrations.count,
        contentAttributions: contentAttributions.count,
        crmOutcomes: crmOutcomes.count,
        abTests: abTests.count,
        abTestAssignments: abTestAssignments.count,
        optimizations: optimizations.count,
        predictionModels: predictionModels.count,
        predictionLogs: predictionLogs.count,
        promptVersions: promptVersions.count,
      };
    });

    console.log('[RESET] All data wiped:', results);

    return NextResponse.json({
      message: 'All accounts and data have been deleted. Fresh start!',
      deleted: results
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/admin/reset-all error:', error);
    return NextResponse.json(
      { error: 'Failed to reset data' },
      { status: 500 }
    );
  }
}
