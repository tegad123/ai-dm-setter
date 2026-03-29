// ---------------------------------------------------------------------------
// In-Memory Event Bus for Server-Sent Events (SSE)
// ---------------------------------------------------------------------------
// This is a simple pub/sub event bus that runs in the same process.
// In production with multiple instances, replace with Redis Pub/Sub.
// ---------------------------------------------------------------------------

export interface RealtimeEvent {
  type: string;
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
    for (const listener of this.listeners) {
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
// ---------------------------------------------------------------------------

export function broadcastNewMessage(data: {
  id: string;
  conversationId: string;
  sender: string;
  content: string;
  timestamp: string;
}): void {
  eventBus.publish({ type: 'message:new', data });
}

export function broadcastConversationUpdate(data: {
  id: string;
  leadId: string;
  aiActive: boolean;
  unreadCount: number;
  lastMessageAt?: string | null;
}): void {
  eventBus.publish({ type: 'conversation:updated', data });
}

export function broadcastAIStatusChange(data: {
  conversationId: string;
  aiActive: boolean;
}): void {
  eventBus.publish({ type: 'ai:status_changed', data });
}

export function broadcastAISuggestion(data: {
  conversationId: string;
  suggestedReply: string;
  stage?: string;
  confidence?: number;
}): void {
  eventBus.publish({ type: 'ai:suggestion', data });
}
