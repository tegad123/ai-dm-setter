/**
 * Real-time event system for DMsetter
 *
 * Uses an in-memory event emitter to broadcast events to connected SSE clients.
 * Supports: new messages, conversation updates, notification delivery, AI status changes.
 */

type EventType =
  | 'message:new'
  | 'conversation:updated'
  | 'notification:new'
  | 'lead:updated'
  | 'ai:status_changed';

interface RealtimeEvent {
  type: EventType;
  data: unknown;
  timestamp: string;
}

type Listener = (event: RealtimeEvent) => void;

class RealtimeEventBus {
  private listeners: Listener[] = [];

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  publish(type: EventType, data: unknown): void {
    const event: RealtimeEvent = {
      type,
      data,
      timestamp: new Date().toISOString()
    };
    for (let i = 0; i < this.listeners.length; i++) {
      try {
        this.listeners[i](event);
      } catch (err) {
        console.error('[Realtime] Listener error:', err);
      }
    }
  }

  get connectionCount(): number {
    return this.listeners.length;
  }
}

// Singleton — shared across all API route handlers in the same process
const globalForRealtime = globalThis as unknown as {
  realtimeEventBus: RealtimeEventBus | undefined;
};

export const eventBus =
  globalForRealtime.realtimeEventBus ?? new RealtimeEventBus();

if (process.env.NODE_ENV !== 'production') {
  globalForRealtime.realtimeEventBus = eventBus;
}

// ── Helper publishers ────────────────────────────────────────────────

export function broadcastNewMessage(message: {
  id: string;
  conversationId: string;
  sender: string;
  content: string;
  timestamp: string;
}) {
  eventBus.publish('message:new', message);
}

export function broadcastConversationUpdate(conversation: {
  id: string;
  leadId: string;
  aiActive: boolean;
  unreadCount: number;
  lastMessageAt?: string;
}) {
  eventBus.publish('conversation:updated', conversation);
}

export function broadcastNotification(notification: {
  id: string;
  type: string;
  title: string;
  body: string;
  leadId?: string;
}) {
  eventBus.publish('notification:new', notification);
}

export function broadcastLeadUpdate(lead: {
  id: string;
  name: string;
  status: string;
  qualityScore: number;
}) {
  eventBus.publish('lead:updated', lead);
}

export function broadcastAIStatusChange(data: {
  conversationId: string;
  aiActive: boolean;
}) {
  eventBus.publish('ai:status_changed', data);
}
