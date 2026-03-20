import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ version: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { version } = await params;

    // Find the prompt version to rollback to
    const targetVersion = await prisma.promptVersion.findFirst({
      where: {
        accountId: auth.accountId,
        version
      }
    });

    if (!targetVersion) {
      return NextResponse.json(
        { error: `Prompt version "${version}" not found` },
        { status: 404 }
      );
    }

    if (!targetVersion.promptContent) {
      return NextResponse.json(
        {
          error: 'This version does not have stored prompt content for rollback'
        },
        { status: 400 }
      );
    }

    // Update the account's AIPersona systemPrompt
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true }
    });

    if (!persona) {
      return NextResponse.json(
        { error: 'No active AI persona found for this account' },
        { status: 404 }
      );
    }

    await prisma.aIPersona.update({
      where: { id: persona.id },
      data: { systemPrompt: targetVersion.promptContent }
    });

    // Calculate incremented version
    const latestVersion = await prisma.promptVersion.findFirst({
      where: { accountId: auth.accountId },
      orderBy: { createdAt: 'desc' }
    });

    const newVersionString = incrementVersion(
      latestVersion?.version || version
    );

    // Create a new PromptVersion record for the rollback
    const newVersion = await prisma.promptVersion.create({
      data: {
        accountId: auth.accountId,
        version: newVersionString,
        promptHash: targetVersion.promptHash,
        description: `Rollback to version ${version}`,
        changeType: 'PATCH',
        appliedBy: 'ADMIN',
        promptContent: targetVersion.promptContent
      }
    });

    return NextResponse.json({
      message: `Successfully rolled back to version ${version}`,
      newVersion: newVersion
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(
      'POST /api/admin/prompt-versions/[version]/rollback error:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to rollback prompt version' },
      { status: 500 }
    );
  }
}

/**
 * Increment the patch segment of a semver string.
 * "1.2.3" -> "1.2.4"
 */
function incrementVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length !== 3) {
    // Fallback: append .1
    return `${version}.1`;
  }
  const patch = parseInt(parts[2], 10);
  return `${parts[0]}.${parts[1]}.${isNaN(patch) ? 1 : patch + 1}`;
}
