/**
 * Unpack the QualifyDMS Glass UI _standalone_.html bundle into readable
 * files so we can study the design system. The bundle stores each asset
 * as a gzipped, base64-encoded entry in a JSON manifest embedded in the
 * page. This script pulls it apart and dumps each asset to
 * ./design-extract/ so we can grep and read the CSS + HTML.
 *
 * Run: npx tsx scripts/unpack-design-bundle.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';

const BUNDLE =
  '/Users/tegaumukoro/Downloads/QualifyDMS Glass UI _standalone_.html';
const OUT_DIR = '/Users/tegaumukoro/DMsetter/ai-dm-setter/design-extract';

function extractScriptBlock(html: string, type: string): string {
  const open = `<script type="${type}">`;
  const start = html.indexOf(open);
  if (start < 0) throw new Error(`missing script tag: ${type}`);
  const contentStart = start + open.length;
  const end = html.indexOf('</script>', contentStart);
  if (end < 0) throw new Error(`unclosed script tag: ${type}`);
  return html.slice(contentStart, end).trim();
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const html = readFileSync(BUNDLE, 'utf8');

  const manifestRaw = extractScriptBlock(html, '__bundler/manifest');
  const templateRaw = extractScriptBlock(html, '__bundler/template');

  writeFileSync(join(OUT_DIR, 'template.raw.html'), templateRaw);
  console.log(`template: ${templateRaw.length} bytes → template.raw.html`);

  const manifest = JSON.parse(manifestRaw) as Record<
    string,
    { mime: string; compressed: boolean; data: string }
  >;
  const index: Array<{
    id: string;
    mime: string;
    bytes: number;
    file: string;
  }> = [];

  for (const [id, entry] of Object.entries(manifest)) {
    const buf = Buffer.from(entry.data, 'base64');
    const out = entry.compressed ? gunzipSync(buf) : buf;
    const ext = guessExt(entry.mime);
    const fileName = `${id}.${ext}`;
    writeFileSync(join(OUT_DIR, fileName), out);
    index.push({
      id,
      mime: entry.mime,
      bytes: out.length,
      file: fileName
    });
    console.log(
      `  ${id.slice(0, 8)} ${entry.mime.padEnd(24)} ${out.length} → ${fileName}`
    );
  }

  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(
    `\nWrote ${index.length} entries + template.raw.html + index.json to ${OUT_DIR}`
  );
}

function guessExt(mime: string): string {
  if (mime.includes('html')) return 'html';
  if (mime.includes('javascript')) return 'js';
  if (mime.includes('css')) return 'css';
  if (mime.includes('json')) return 'json';
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('woff2')) return 'woff2';
  if (mime.includes('woff')) return 'woff';
  if (mime.includes('font')) return 'ttf';
  return 'bin';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
