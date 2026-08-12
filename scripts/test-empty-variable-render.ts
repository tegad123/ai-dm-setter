// Fix D Phase 2 (D2) — empty-variable-render gate detector.
// Mirrors the exact regexes in voice-quality-gate.ts so the pattern is
// guarded against drift + false positives. Run:
// NODE_PATH=$PWD/node_modules npx tsx scripts/test-empty-variable-render.ts

const EMPTY_SLOT_SCAR_RE =
  /\b(wanting|for|your|of|about|toward|towards|around|reach|hit|achieve|build)\s+([,.;!?]|and\b|so\b|but\b|because\b)/i;
const doubleCommaScar = /,\s*,/;
const DOUBLE_SPACE_SCAR_RE = /\b(wanting|reach|toward|towards|achieve)\s{2,}/i;

function scar(reply: string): string | null {
  const m =
    EMPTY_SLOT_SCAR_RE.exec(reply) ??
    doubleCommaScar.exec(reply) ??
    DOUBLE_SPACE_SCAR_RE.exec(reply);
  return m ? m[0].trim() : null;
}

let passed = 0;
let failed = 0;
function expect(label: string, reply: string, shouldFlag: boolean) {
  const flagged = scar(reply) !== null;
  if (flagged === shouldFlag) passed++;
  else {
    failed++;
    console.error(
      `  ❌ ${label}: expected ${shouldFlag ? 'FLAG' : 'PASS'} got ${flagged ? 'FLAG' : 'PASS'} — ${JSON.stringify(reply)}`
    );
  }
}

// ── The D2 bug family: unfilled {{variable}} leaves a scar ──────────
expect(
  'stranded comma after wanting',
  'so you get some breathing room, wanting , and more time bro',
  true
);
expect(
  'stranded comma after toward',
  'building toward , that makes sense',
  true
);
expect('double comma', 'yeah man, , what got you into it', true);
expect(
  'double space after wanting',
  'i hear you, wanting  for your family hits different',
  true
);
expect('double space after reach', 'so you can reach  faster bro', true);

// ── Safe copy that must NOT flag ───────────────────────────────────
expect('plain question', 'what got you into trading bro?', false);
expect('for real idiom', 'for real man that makes sense', false);
expect('your goal filled', 'your goal of 15k a month is solid', false);
expect('wanting + real value', 'wanting more freedom, i respect that', false);
expect('building filled', 'building a real system takes time', false);
expect('so you can', 'so you can reach your goals faster', false);
expect('about duration', 'about 2 years now, been grinding', false);
expect('want single space', 'i want to help you out bro', false);

console.log(`empty-variable-render tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
