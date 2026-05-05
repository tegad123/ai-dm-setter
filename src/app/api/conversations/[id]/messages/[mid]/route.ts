import { unsendConversationMessage } from '@/lib/conversation-message-unsend';
import { NextRequest } from 'next/server';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  return unsendConversationMessage(request, { params });
}
