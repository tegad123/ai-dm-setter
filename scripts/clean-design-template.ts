/**
 * The template.raw.html is JSON-string-encoded (a single quoted string
 * with \n, \u002F, etc). Decode to clean HTML so we can grep it.
 */
import { readFileSync, writeFileSync } from 'fs';

const IN =
  '/Users/tegaumukoro/DMsetter/ai-dm-setter/design-extract/template.raw.html';
const OUT =
  '/Users/tegaumukoro/DMsetter/ai-dm-setter/design-extract/template.html';

const raw = readFileSync(IN, 'utf8');
// The file is a JSON-encoded string literal. Use JSON.parse on it.
const decoded = JSON.parse(raw);
writeFileSync(OUT, decoded);
console.log(`decoded ${raw.length} → ${decoded.length} bytes → ${OUT}`);
