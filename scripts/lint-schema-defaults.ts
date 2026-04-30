/* eslint-disable no-console */
// Schema lint — enforce that every field on Conversation, Lead, and
// Account is either nullable (`?`) OR has a `@default(...)` clause.
//
// Why this exists: 5415c8e shipped Account.manyChatWebhookKey as
// `String @unique @default(uuid())` AND a backfill migration. That
// migration was authored correctly. But the prisma schema syntax
// makes it tempting to write `String @unique` without a default
// while authoring — which would have left existing 1543 daetradez
// Account rows without a value, breaking the NOT NULL constraint at
// migrate time. This lint catches that class at commit-time, before
// the migration ever runs.
//
// Rule: in models {Account, Lead, Conversation}, every scalar/enum
// field MUST either:
//   • end with `?` (nullable), OR
//   • declare `@default(value)`, OR
//   • be the `@id` field (id has implicit default), OR
//   • be a foreign-key column that pairs with a `@relation` field
//     in the same model (FKs are always set at INSERT by the
//     creating code path).
//
// Relations and back-references are skipped.
//
// Usage: pnpm db:lint-schema
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TARGET_MODELS = new Set(['Account', 'Lead', 'Conversation']);

// Grandfathered fields that pre-date this rule (2026-04-30). All
// were declared in the initial table-create migrations where NOT
// NULL is fine — no existing rows could be broken since the table
// was empty. Every NEW field added going forward must comply with
// the rule (nullable OR @default), so this set should not grow.
const GRANDFATHERED = new Set([
  'Account.name',
  'Account.slug',
  'Lead.name',
  'Lead.handle',
  'Lead.platform',
  'Lead.triggerType'
]);

interface FieldIssue {
  model: string;
  field: string;
  type: string;
  reason: string;
}

function main() {
  const schemaPath = resolve(__dirname, '..', 'prisma/schema.prisma');
  const schemaText = readFileSync(schemaPath, 'utf-8');

  // Collect declared model + enum names so we can classify field types.
  const modelNames = new Set<string>();
  const enumNames = new Set<string>();
  let m: RegExpExecArray | null;
  const modelDeclRe = /^model\s+(\w+)\s*\{/gm;
  while ((m = modelDeclRe.exec(schemaText)) !== null) modelNames.add(m[1]);
  const enumDeclRe = /^enum\s+(\w+)\s*\{/gm;
  while ((m = enumDeclRe.exec(schemaText)) !== null) enumNames.add(m[1]);

  // First pass on each target model: collect FK column names so we
  // can exempt them. An FK is the `String` field that's referenced by
  // a `@relation(fields: [<fkName>], references: [...])` clause.
  const issues: FieldIssue[] = [];
  const modelBodyRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  while ((m = modelBodyRe.exec(schemaText)) !== null) {
    const modelName = m[1];
    if (!TARGET_MODELS.has(modelName)) continue;
    const body = m[2];

    // Pass 1: discover FK column names.
    const fkColumns = new Set<string>();
    const relationRe = /@relation\([^)]*fields:\s*\[([^\]]+)\]/g;
    let r: RegExpExecArray | null;
    while ((r = relationRe.exec(body)) !== null) {
      for (const col of r[1].split(',')) {
        fkColumns.add(col.trim());
      }
    }

    // Pass 2: lint each field.
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('//')) continue;
      if (line.startsWith('@@')) continue;
      const tok = line.match(/^(\w+)\s+(\S+)/);
      if (!tok) continue;
      const [, name, typeText] = tok;

      // Skip relation fields: type is a model name (with optional `?`
      // or `[]`).
      const baseType = typeText.replace(/\??\[\]$/, '').replace(/\?$/, '');
      if (modelNames.has(baseType)) continue;
      // Skip array primitives (`String[]`) — same shape, not a column.
      if (typeText.endsWith('[]')) continue;

      // Skip @id fields (id has an implicit default via @default(cuid())
      // or @default(uuid()), and even when raw, Prisma fills it).
      if (/@id\b/.test(line)) continue;
      // Skip @updatedAt — Prisma maintains it.
      if (/@updatedAt\b/.test(line)) continue;
      // Skip foreign keys discovered in pass 1.
      if (fkColumns.has(name)) continue;
      // Grandfather pre-rule fields.
      if (GRANDFATHERED.has(`${modelName}.${name}`)) continue;

      // The actual rule.
      const isNullable = typeText.endsWith('?');
      const hasDefault = /@default\s*\(/.test(line);
      if (!isNullable && !hasDefault) {
        issues.push({
          model: modelName,
          field: name,
          type: typeText,
          reason: 'required field has no @default'
        });
      }
    }
  }

  // Suppress unused-vars warning — enumNames left in scope for
  // future expansion (e.g. enum-value drift).
  void enumNames;

  if (issues.length === 0) {
    console.log(
      `✓ Schema lint passed — every required field on Account / Lead / Conversation has @default or is nullable.`
    );
    return;
  }
  console.error(
    `✗ Schema lint failed — ${issues.length} required field(s) missing @default or ? on the high-volume tables:`
  );
  for (const i of issues) {
    console.error(`  ${i.model}.${i.field}  (${i.type}) — ${i.reason}`);
  }
  console.error(
    `\nFix: either add @default(value), mark the field nullable with ?, or — if it's a foreign key — pair it with a @relation(fields: [${'<this>'}]).`
  );
  process.exit(1);
}

main();
