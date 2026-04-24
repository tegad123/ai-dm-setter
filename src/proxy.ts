import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/auth(.*)',
  '/privacy',
  '/terms',
  '/glass-preview',
  '/api/webhooks(.*)',
  '/api/auth/meta(.*)',
  '/api/auth/instagram(.*)',
  '/api/meta/(.*)',
  '/api/realtime(.*)',
  // Cron handlers do their own bearer-token auth via CRON_SECRET. If
  // Clerk runs first, an unauthenticated request returns 404 (Clerk's
  // default for API routes), which is what we were seeing in the
  // production logs for the every-minute scheduled-replies cron.
  '/api/cron(.*)'
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals, static files, AND webhook/callback/cron routes
    '/((?!_next|api/webhooks|api/auth/meta/callback|api/auth/instagram/callback|api/meta/|api/cron/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // API routes except webhooks, callbacks, and cron handlers
    '/(api(?!/webhooks|/auth/meta/callback|/auth/instagram/callback|/meta/|/cron/)|trpc)(.*)'
  ]
};
