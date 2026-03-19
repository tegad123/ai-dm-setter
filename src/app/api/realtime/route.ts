import { eventBus } from '@/lib/realtime';

/**
 * Server-Sent Events (SSE) endpoint for real-time updates.
 *
 * Clients connect via EventSource('/api/realtime') and receive events
 * as they are published to the in-memory event bus.
 *
 * Event format:
 *   event: message:new
 *   data: {"id":"...","conversationId":"...","content":"..."}
 */
export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(
          `event: connected\ndata: ${JSON.stringify({ status: 'ok', connections: eventBus.connectionCount + 1 })}\n\n`
        )
      );

      // Keep-alive every 30 seconds
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepAlive);
        }
      }, 30_000);

      // Subscribe to all events
      const unsubscribe = eventBus.subscribe((event) => {
        try {
          const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Client disconnected
          unsubscribe();
          clearInterval(keepAlive);
        }
      });

      // Cleanup on abort
      const cleanup = () => {
        unsubscribe();
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      // Store cleanup for abort signal
      (controller as unknown as { _cleanup: () => void })._cleanup = cleanup;
    },
    cancel() {
      // Stream cancelled by client
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
