// ---------------------------------------------------------------------------
// In-Memory Event Bus for Server-Sent Events (SSE)
// ---------------------------------------------------------------------------
// This is a simple pub/sub event bus that runs in the same process.
// In production with multiple instances, replace with Redis Pub/Sub.
//
// SECURITY (P0 fix 2026-05-04): every event MUST carry an accountId so
// the SSE route handler can filter the stream to the authenticated
// caller's account. Cross-tenant emission was the root of the
// unauthenticated SSE leak — enforcing accountId at the bus layer plus
// `requireAuth` at the route is the belt-and-suspenders fix.
// ---------------------------------------------------------------------------

export interface RealtimeEvent {
  type: string;
  /**
   * Tenant scope. The SSE route filters events to
   * `event.accountId === auth.accountId` so a connected client only
   * receives traffic for their own tenant. Required — broadcasts
   * without an accountId are a programmer bug.
   */
  accountId: string;
  data: Record<string, unknown>;
}

type Listener = (event: RealtimeEvent) => void;

class EventBus {
  private listeners: Set<Listener> = new Set();

  get connectionCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: RealtimeEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (err) {
        console.error('[realtime] Listener error:', err);
      }
    }
  }
}

// Singleton event bus
export const eventBus = new EventBus();

// ---------------------------------------------------------------------------
// Convenience broadcast helpers
//
// Every helper takes `accountId` as the first positional argument and
// publishes it on the event envelope. The SSE route uses it to scope
// the stream — a missed accountId would mean a leak, so make it loud
// with the required-positional shape rather than an optional field on
// the data object.
// ---------------------------------------------------------------------------

export function broadcastNewMessage(
  accountId: string,
  data: {
    id: string;
    conversationId: string;
    sender: string;
    content: string;
    imageUrl?: string | null;
    hasImage?: boolean;
    mediaType?: string | null;
    mediaUrl?: string | null;
    transcription?: string | null;
    imageMetadata?: unknown;
    mediaProcessedAt?: string | null;
    mediaProcessingError?: string | null;
    humanSource?: 'DASHBOARD' | 'PHONE' | null;
    sentByUser?: { id: string; name: string; email?: string | null } | null;
    platformMessageId?: string | null;
    timestamp: string;
    // Multi-bubble fields. Null/undefined for legacy single-message sends
    // (the UI treats absence as an implicit 1-bubble group). When present,
    // the UI groups bubbles with the same messageGroupId visually.
    messageGroupId?: string | null;
    bubbleIndex?: number | null;
    bubbleTotalCount?: number | null;
  }
): void {
  eventBus.publish({ type: 'message:new', accountId, data });
}

export function broadcastConversationUpdate(
  accountId: string,
  data: {
    id: string;
    leadId: string;
    aiActive: boolean;
    unreadCount: number;
    lastMessageAt?: string | null;
  }
): void {
  eventBus.publish({ type: 'conversation:updated', accountId, data });
}

// Soft-deletion of a Message. Fires on:
//   - Inbound: IG webhook reports the lead unsent a DM (deletedSource =
//     'INSTAGRAM', deletedBy = 'LEAD').
//   - Outbound: an operator unsent from the dashboard (deletedSource =
//     'DASHBOARD', deletedBy = userId).
// The dashboard listens for this and either greys-out the message bubble
// or removes it depending on UI preference. The Message row stays in
// the DB — `deletedAt` is what flips the rendering.
export function broadcastMessageDeleted(
  accountId: string,
  data: {
    id: string;
    conversationId: string;
    deletedAt: string;
    deletedBy: string | null;
    deletedSource: string | null;
  }
): void {
  eventBus.publish({ type: 'message:deleted', accountId, data });
}

export function broadcastAIStatusChange(
  accountId: string,
  data: {
    conversationId: string;
    aiActive: boolean;
  }
): void {
  eventBus.publish({ type: 'ai:status_changed', accountId, data });
}

export function broadcastLeadUpdate(
  accountId: string,
  data: Record<string, unknown>
): void {
  eventBus.publish({ type: 'lead:updated', accountId, data });
}

export function broadcastNotification(
  accountId: string,
  data: Record<string, unknown>
): void {
  eventBus.publish({ type: 'notification:new', accountId, data });
}

export function broadcastAISuggestion(
  accountId: string,
  data: {
    conversationId: string;
    suggestedReply: string;
    stage?: string;
    confidence?: number;
  }
): void {
  eventBus.publish({ type: 'ai:suggestion', accountId, data });
}
