import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/auth(.*)',
  '/privacy',
  '/terms',
  '/api/webhooks(.*)',
  '/api/auth/meta(.*)',
  '/api/auth/instagram(.*)',
  '/api/meta/(.*)',
  '/api/realtime(.*)'
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals, static files, AND webhook/callback routes
    '/((?!_next|api/webhooks|api/auth/meta/callback|api/auth/instagram/callback|api/meta/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // API routes except webhooks and callbacks
    '/(api(?!/webhooks|/auth/meta/callback|/auth/instagram/callback|/meta/)|trpc)(.*)'
  ]
};
