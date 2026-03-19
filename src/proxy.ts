import { NextRequest, NextResponse } from 'next/server';

// Simple middleware — will add JWT auth protection in Phase 2
export default function middleware(req: NextRequest) {
  // For now, allow all requests through
  // TODO: Add JWT token verification for /dashboard routes
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)'
  ]
};
