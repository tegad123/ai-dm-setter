/* eslint-disable no-console */
// Schema-DB drift guard. Compares each Prisma model's expected column
// list (parsed from schema.prisma) against what's actually present in
// the live Postgres database. Exits non-zero on drift so CI / pre-push
// can block a deploy that would crash at runtime.
//
// Was added 2026-04-30 after a P0 — commit 5415c8e shipped 9 new
// columns on Conversation + 1 on Account but the migration was never
// applied to production. Result: prisma.conversation.findMany threw
// "column does not exist", the API returned errors, the dashboard
// showed "No conversations yet" while 1543 rows sat untouched in DB.
//
// Build now runs `prisma migrate deploy` so this script is the
// belt-and-suspenders that yells if a deploy somehow skipped it.
//
// Usage: pnpm db:check-drift
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });
import { readFileSync } from 'fs';
import { resolve } from 'path';
import prisma from '../src/lib/prisma';

interface DbColumn {
  table_name: string;
  column_name: string;
}

async function main() {
  const schemaPath = resolve(__dirname, '..', 'prisma/schema.prisma');
  const schemaText = readFileSync(schemaPath, 'utf-8');

  // Extract the column names declared on each Prisma model. We don't
  // need the full grammar — model blocks start with `model X {` and
  // end with the next `}` at column 0; field names are the first
  // non-comment, non-relation, non-attribute identifier on a line.
  // Skips `@@` block attributes, relation backreferences (uppercase-
  // type lines without a `@map`), and lines with `[]` (relation
  // arrays — present only on the model side, not as DB columns).
  // Collect declared model + enum names so we can correctly classify
  // each field's type. Anything matching a model name is a relation
  // (skip from the column list); anything matching an enum name is a
  // real column.
  const modelNames = new Set<string>();
  const enumNames = new Set<string>();
  let modelMatch: RegExpExecArray | null;
  const modelDeclRe = /^model\s+(\w+)\s*\{/gm;
  while ((modelMatch = modelDeclRe.exec(schemaText)) !== null) {
    modelNames.add(modelMatch[1]);
  }
  let enumMatch: RegExpExecArray | null;
  const enumDeclRe = /^enum\s+(\w+)\s*\{/gm;
  while ((enumMatch = enumDeclRe.exec(schemaText)) !== null) {
    enumNames.add(enumMatch[1]);
  }

  const expected: Record<string, Set<string>> = {};
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = modelRe.exec(schemaText)) !== null) {
    const modelName = m[1];
    const body = m[2];
    const fields = new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('//')) continue;
      if (line.startsWith('@@')) continue;
      const tokenMatch = line.match(/^(\w+)\s+(\S+)/);
      if (!tokenMatch) continue;
      const [, name, typeText] = tokenMatch;
      // Skip array relations ("Lead[]" etc.).
      if (typeText.endsWith('[]')) continue;
      const baseType = typeText.replace(/\?$/, '');
      // Skip any field whose type is a declared model — that's a
      // relation back-reference, not a DB column. Enum types ARE
      // real columns, so keep those.
      if (modelNames.has(baseType)) continue;
      fields.add(name);
    }
    expected[modelName] = fields;
  }
  // Suppress unused-vars warning — enumNames left in scope for
  // future expansion (e.g. enum-value drift checks).
  void enumNames;

  // Pull live DB columns. Map Postgres table name → Prisma model name
  // (Prisma's default table mapping is identity for our schema).
  const cols = await prisma.$queryRawUnsafe<DbColumn[]>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const actual: Record<string, Set<string>> = {};
  for (const c of cols) {
    if (!actual[c.table_name]) actual[c.table_name] = new Set();
    actual[c.table_name].add(c.column_name);
  }

  const drift: { model: string; missing: string[] }[] = [];
  for (const [model, fields] of Object.entries(expected)) {
    // Skip models we know aren't backed by a table (none in this
    // schema, but safe-guard for future @@map / view-only models).
    const tableCols = actual[model];
    if (!tableCols) {
      drift.push({ model, missing: ['<table missing entirely>'] });
      continue;
    }
    const missing: string[] = [];
    fields.forEach((f) => {
      if (!tableCols.has(f)) missing.push(f);
    });
    if (missing.length > 0) drift.push({ model, missing });
  }

  if (drift.length === 0) {
    console.log(
      '✓ Schema-DB drift check passed — all expected columns present.'
    );
    await prisma.$disconnect();
    process.exit(0);
  }

  console.error('✗ Schema-DB drift detected:');
  for (const d of drift) {
    console.error(`  ${d.model}: missing ${d.missing.join(', ')}`);
  }
  console.error(
    '\nLikely cause: a migration was committed but `prisma migrate deploy` did not run.\n  Fix: pnpm dlx prisma migrate deploy\n  Long-term: ensure the build step runs migrations (already added 2026-04-30).'
  );
  await prisma.$disconnect();
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
