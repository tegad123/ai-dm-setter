// Compile-on-demand for a script that is not uploaded yet: parse the raw
// markdown exactly as the upload route does, run the compiler, print the
// step count, errors and warnings. Nothing is written anywhere.
//
// Run:
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/compile-script-text.ts /path/to/script.md [--account <accountId>] [--json]
//   (parseScriptMarkdown uses the configured LLM parser; needs the API keys from .env)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseScriptMarkdown } from '@/lib/script-parser';
import {
  compileScript,
  parsedScriptToCompilable,
  formatCompileErrors
} from '@/lib/script-fsm/compiler';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: compile-script-text.ts <script.md> [--json]');
    process.exit(1);
  }
  const text = readFileSync(file, 'utf8');
  // The parser is account-scoped (LLM provider + persona config). Default to
  // Daniel's workspace; pass --account for another.
  const ai = process.argv.indexOf('--account');
  const accountId =
    ai >= 0 ? process.argv[ai + 1] : 'cmpy59zy50000ju04u6fs5o2r';
  const parsed = await parseScriptMarkdown(accountId, text);
  const steps = parsedScriptToCompilable(parsed.steps);
  const fsm = compileScript(steps);
  const errors = fsm.diagnostics.filter((d) => d.severity === 'error');
  const warnings = fsm.diagnostics.filter((d) => d.severity === 'warning');
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          steps: fsm.nodes.length,
          errors,
          warnings,
          nodes: fsm.nodes.map((n) => ({
            step: n.stepNumber,
            title: n.title,
            edges: n.edges.map(
              (e) =>
                `${e.branchLabel}${e.isDefault ? ' [default]' : ''} → ${e.completion.kind}`
            )
          }))
        },
        null,
        2
      )
    );
    return;
  }
  console.log(
    `steps: ${fsm.nodes.length}   errors: ${errors.length}   warnings: ${warnings.length}   compilerVersion: ${fsm.compilerVersion}`
  );
  for (const n of fsm.nodes) {
    console.log(`  ${String(n.stepNumber).padStart(2)}. ${n.title}`);
    for (const e of n.edges)
      console.log(
        `      - ${e.branchLabel}${e.isDefault ? ' [default]' : ''}  → ${e.completion.kind}${'waits' in e.completion ? ` (waits ${e.completion.waits})` : ''}`
      );
  }
  if (errors.length) {
    console.log(
      '\nERRORS (upload would be rejected with FIX_D_ROUTING_REJECT_ON_INVALID):'
    );
    for (const l of formatCompileErrors(fsm)) console.log('  ' + l);
  }
  if (warnings.length) {
    console.log('\nWARNINGS:');
    for (const w of warnings)
      console.log(`  step ${w.stepNumber ?? '-'}: ${w.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
