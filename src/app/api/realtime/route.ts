import { NextRequest, NextResponse } from 'next/server';
import { eventBus } from '@/lib/realtime';
import { requireAuth, AuthError } from '@/lib/auth-guard';

/**
 * Server-Sent Events (SSE) endpoint for real-time updates.
 *
 * Clients connect via EventSource('/api/realtime') and receive events
 * as they are published to the in-memory event bus.
 *
 * SECURITY (P0 fix 2026-05-04):
 *   1. `requireAuth` enforces a session — unauthenticated requests get
 *      a 401 immediately, no SSE stream is opened.
 *   2. The subscription filters every published event to those whose
 *      `accountId` matches the authenticated caller's. Cross-tenant
 *      events on the in-process bus stay invisible to this client.
 *   3. The route is also removed from the Clerk public-route matcher
 *      in src/proxy.ts so even if `requireAuth` were bypassed, Clerk
 *      blocks at the proxy layer.
 *
 * Event format on the wire:
 *   event: message:new
 *   data: {"id":"...","conversationId":"...","content":"..."}
 *
 * The `accountId` field is intentionally NOT serialized to the client
 * — it's used server-side for routing and isn't useful to the dashboard.
 */
export async function GET(request: NextRequest) {
  let accountId: string;
  try {
    const auth = await requireAuth(request);
    accountId = auth.accountId;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

      // Subscribe with per-tenant filter. Events on the in-process
      // bus may belong to any account; this listener short-circuits
      // unless the event's accountId matches the connected client's.
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.accountId !== accountId) return;
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
