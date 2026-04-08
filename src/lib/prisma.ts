import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Vercel serverless tuning. Each lambda invocation spins up its own
// PrismaClient and (without this override) opens up to 5 connections
// to Postgres. With ~50 concurrent webhook lambdas that's 250+
// connections trying to share a fixed database connection cap, which
// in production caused:
//   prisma.lead.update() → "Timed out fetching a new connection from
//   the connection pool. (Current connection pool timeout: 10,
//   connection limit: 5)"
// followed by 504 Gateway Timeouts on the Instagram webhook.
// Forcing connection_limit=1 makes each lambda hold exactly one
// connection, which scales linearly with the function concurrency
// instead of multiplying it. We also bump pool_timeout so cold
// starts under burst load have a little more headroom before
// failing the request.
function buildDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', '1');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '20');
    }
    return url.toString();
  } catch {
    // If DATABASE_URL is malformed let Prisma surface the real error
    // instead of swallowing it here.
    return raw;
  }
}

const datasourceUrl = buildDatabaseUrl();

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
