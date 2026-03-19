'use client';

import { useEffect, useRef, useCallback } from 'react';

type EventType =
  | 'message:new'
  | 'conversation:updated'
  | 'notification:new'
  | 'lead:updated'
  | 'ai:status_changed';

type RealtimeHandler = (data: unknown) => void;

/**
 * Hook to subscribe to real-time Server-Sent Events.
 *
 * Usage:
 *   useRealtime('message:new', (data) => {
 *     console.log('New message:', data);
 *     refetchMessages();
 *   });
 */
export function useRealtime(eventType: EventType, handler: RealtimeHandler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const eventSource = new EventSource('/api/realtime');

    eventSource.addEventListener(eventType, (event) => {
      try {
        const data = JSON.parse(event.data);
        handlerRef.current(data);
      } catch (err) {
        console.error(`[useRealtime] Failed to parse ${eventType}:`, err);
      }
    });

    eventSource.onerror = () => {
      // Auto-reconnect is built into EventSource
      console.warn('[useRealtime] Connection error — will auto-reconnect');
    };

    return () => {
      eventSource.close();
    };
  }, [eventType]);
}

/**
 * Hook to subscribe to multiple real-time events at once.
 *
 * Usage:
 *   useRealtimeMulti({
 *     'message:new': (data) => refetchMessages(),
 *     'notification:new': (data) => refetchNotifications(),
 *   });
 */
export function useRealtimeMulti(
  handlers: Partial<Record<EventType, RealtimeHandler>>
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const eventSource = new EventSource('/api/realtime');

    const eventTypes = Object.keys(handlersRef.current) as EventType[];

    for (const eventType of eventTypes) {
      eventSource.addEventListener(eventType, (event) => {
        try {
          const data = JSON.parse(event.data);
          handlersRef.current[eventType]?.(data);
        } catch (err) {
          console.error(
            `[useRealtimeMulti] Failed to parse ${eventType}:`,
            err
          );
        }
      });
    }

    eventSource.onerror = () => {
      console.warn('[useRealtimeMulti] Connection error — will auto-reconnect');
    };

    return () => {
      eventSource.close();
    };
  }, []);
}

/**
 * Hook that returns a stable function to manually trigger SSE reconnection.
 */
export function useRealtimeConnection() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const isConnected = useRef(false);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource('/api/realtime');
    eventSourceRef.current = es;

    es.addEventListener('connected', () => {
      isConnected.current = true;
    });

    es.onerror = () => {
      isConnected.current = false;
    };

    return es;
  }, []);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      isConnected.current = false;
    }
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { connect, disconnect, isConnected };
}
