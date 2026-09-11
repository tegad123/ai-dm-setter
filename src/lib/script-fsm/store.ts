// ---------------------------------------------------------------------------
// script-fsm/store.ts — compile a persisted script and store the FSM on the
// Script row; load it cheaply per turn with a process-level cache.
// ---------------------------------------------------------------------------
// Storage decision (M5 plan §2): one JSON blob on `Script.compiledFsm` +
// `compiledFsmVersion`. Nullable = "not yet compiled" → runtime falls back
// to legacy routing, which is the shadow safety net. No rows-per-node model
// (that would reintroduce per-turn multi-reads). Rejection at upload lives in
// the routes (compile the parser output BEFORE persist); this module handles
// the post-persist store for both new uploads and reupload/edit paths.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import {
  compileScript,
  hasCompileErrors,
  type CompilableStep
} from './compiler';
import { COMPILER_VERSION, type CompiledScriptFsm } from './types';

const cache = new Map<string, { version: number; fsm: CompiledScriptFsm }>();

export async function loadScriptStepsForCompile(
  scriptId: string
): Promise<CompilableStep[]> {
  const steps = await prisma.scriptStep.findMany({
    where: { scriptId },
    orderBy: { stepNumber: 'asc' },
    select: {
      stepNumber: true,
      title: true,
      actions: {
        where: { branchId: null },
        orderBy: { sortOrder: 'asc' },
        select: {
          actionType: true,
          content: true,
          linkUrl: true,
          linkLabel: true,
          waitDuration: true,
          sortOrder: true
        }
      },
      branches: {
        orderBy: { sortOrder: 'asc' },
        select: {
          branchLabel: true,
          conditionDescription: true,
          sortOrder: true,
          actions: {
            orderBy: { sortOrder: 'asc' },
            select: {
              actionType: true,
              content: true,
              linkUrl: true,
              linkLabel: true,
              waitDuration: true,
              sortOrder: true
            }
          }
        }
      }
    }
  });
  return steps;
}

/** Compile the persisted script and store the result. Never throws on
 *  compile diagnostics (they are data); returns the FSM for the caller to
 *  surface. Storage failures are logged, not thrown. */
export async function compileAndStoreScriptFsm(
  scriptId: string
): Promise<CompiledScriptFsm> {
  const steps = await loadScriptStepsForCompile(scriptId);
  const fsm = compileScript(steps);
  try {
    await prisma.script.update({
      where: { id: scriptId },
      data: {
        compiledFsm: fsm as unknown as object,
        compiledFsmVersion: COMPILER_VERSION
      }
    });
    cache.set(scriptId, { version: COMPILER_VERSION, fsm });
    console.log(
      `[script-fsm] compiled script ${scriptId}: ${fsm.nodes.length} nodes, ` +
        `${fsm.diagnostics.filter((d) => d.severity === 'error').length} errors, ` +
        `${fsm.diagnostics.filter((d) => d.severity === 'warning').length} warnings`
    );
  } catch (err) {
    console.error(
      '[script-fsm] store failed (non-fatal):',
      err instanceof Error ? err.message : err
    );
  }
  return fsm;
}

/** The compiled FSM for an account's ACTIVE script, or null when not compiled
 *  (legacy routing applies). Compiles lazily on first use so existing scripts
 *  need no backfill. */
export async function getActiveScriptFsm(
  accountId: string
): Promise<{ scriptId: string; fsm: CompiledScriptFsm } | null> {
  const script = await prisma.script.findFirst({
    where: { accountId, isActive: true },
    select: { id: true, compiledFsm: true, compiledFsmVersion: true }
  });
  if (!script) return null;
  const cached = cache.get(script.id);
  if (cached && cached.version === (script.compiledFsmVersion ?? -1)) {
    return { scriptId: script.id, fsm: cached.fsm };
  }
  if (script.compiledFsm && script.compiledFsmVersion === COMPILER_VERSION) {
    const fsm = script.compiledFsm as unknown as CompiledScriptFsm;
    cache.set(script.id, { version: COMPILER_VERSION, fsm });
    return { scriptId: script.id, fsm };
  }
  // Not compiled (or stale version): compile now and store.
  const fsm = await compileAndStoreScriptFsm(script.id);
  return { scriptId: script.id, fsm };
}

export function invalidateScriptFsmCache(scriptId?: string): void {
  if (scriptId) cache.delete(scriptId);
  else cache.clear();
}

export { hasCompileErrors };
