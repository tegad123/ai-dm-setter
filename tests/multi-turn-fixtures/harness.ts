// Multi-turn replay harness — drives a fixture through the REAL stateful
// position logic (computeSystemStage) turn-by-turn, carrying state forward the
// same way the live prepareScriptState loop does, and evaluates the stateful
// checks (no parking, bounded lag, reaches terminal step).

import {
  computeSystemStage,
  type ScriptHistoryMessage
} from '../../src/lib/script-state-recovery';
import type { MultiTurnFixture, MultiTurnScriptStep } from './types';

export interface TurnTrace {
  turn: number;
  aiStepNumber: number; // authoring truth
  trackedStep: number; // what computeSystemStage returned (carried forward)
  reason: string;
  lag: number; // aiStepNumber - trackedStep
}

export interface HarnessResult {
  passed: boolean;
  traces: TurnTrace[];
  failures: string[];
}

// Build a script object shaped like computeSystemStage expects (mirrors the
// askStep() helper in tests/unit/script-state-recovery.test.ts). Each step is
// an ask_question + wait_for_response.
function buildScript(steps: MultiTurnScriptStep[]): any {
  return {
    id: 'multi_turn_script',
    steps: steps.map((s) => ({
      stepNumber: s.stepNumber,
      title: s.title,
      stateKey: s.stateKey ?? null,
      recoveryActionType: null,
      canonicalQuestion: s.question,
      artifactField: null,
      completionRule: null,
      requiredDataPoints: null,
      routingRules: null,
      branches: [],
      actions: [
        { actionType: 'ask_question', content: s.question },
        { actionType: 'wait_for_response', content: null }
      ]
    }))
  };
}

export function runMultiTurnFixture(fixture: MultiTurnFixture): HarnessResult {
  const script = buildScript(fixture.script);
  const history: ScriptHistoryMessage[] = [];
  const traces: TurnTrace[] = [];
  const failures: string[] = [];

  // State carried forward across turns — exactly what the live loop persists.
  let previousCurrentScriptStep: number | null = null;
  let consecutiveSameStep = 0;
  let lastTrackedStep: number | null = null;

  // capturedDataPoints carried forward (incl. branchHistory). The live flow
  // writes a `branch_selected` event (with the generating suggestionId) each
  // time the AI sends a step's reply — we mirror that so the harness exercises
  // the same state the real prepareScriptState loop sees.
  const points: Record<string, unknown> = { branchHistory: [] as any[] };

  const baseTime = Date.parse('2026-06-07T00:00:00Z');
  let clock = baseTime;
  const nextTs = () => new Date((clock += 60_000));

  for (const turn of fixture.turns) {
    const aiTs = nextTs();
    const aiMessageId = `ai_${turn.turn}`;
    // Append the AI message (what the AI actually sent — may be paraphrased)
    history.push({
      sender: 'AI',
      id: aiMessageId,
      content: turn.aiMessage,
      suggestionId: turn.aiSuggestionId ?? null,
      timestamp: aiTs
    });
    // Mirror the live `branch_selected` write for the step this AI message
    // belongs to (carries the suggestionId — the reliable completion key).
    (points.branchHistory as any[]).push({
      eventType: 'branch_selected',
      stepNumber: turn.aiStepNumber,
      stepTitle:
        fixture.script.find((s) => s.stepNumber === turn.aiStepNumber)?.title ??
        null,
      selectedBranchLabel: null,
      suggestionId: turn.aiSuggestionId ?? null,
      aiMessageId,
      aiMessageIds: [aiMessageId],
      leadMessageId: null,
      sentAt: aiTs.toISOString(),
      completedAt: null,
      createdAt: aiTs.toISOString()
    });
    // Append the lead reply
    history.push({
      sender: 'LEAD',
      id: `lead_${turn.turn}`,
      content: turn.leadReply,
      timestamp: nextTs()
    });

    // Drive the REAL position computation with state carried forward, exactly
    // like prepareScriptState (maxAdvanceSteps:1).
    const result = computeSystemStage(script, points as any, history, {
      previousCurrentScriptStep,
      maxAdvanceSteps: 1
    });
    const trackedStep = result.step?.stepNumber ?? 1;
    const lag = turn.aiStepNumber - trackedStep;

    traces.push({
      turn: turn.turn,
      aiStepNumber: turn.aiStepNumber,
      trackedStep,
      reason: result.reason,
      lag
    });

    // Parking detection
    if (lastTrackedStep !== null && trackedStep === lastTrackedStep) {
      consecutiveSameStep += 1;
    } else {
      consecutiveSameStep = 0;
    }
    lastTrackedStep = trackedStep;
    previousCurrentScriptStep = trackedStep;

    // Per-turn checks
    if (
      typeof fixture.checks.maxLagFromTrue === 'number' &&
      lag > fixture.checks.maxLagFromTrue
    ) {
      failures.push(
        `turn ${turn.turn}: lag ${lag} > maxLagFromTrue ${fixture.checks.maxLagFromTrue} (true step ${turn.aiStepNumber}, tracked ${trackedStep})`
      );
    }
    if (
      typeof fixture.checks.maxConsecutiveSameStep === 'number' &&
      consecutiveSameStep >= fixture.checks.maxConsecutiveSameStep &&
      turn.aiStepNumber > trackedStep // conversation moved but tracker didn't
    ) {
      failures.push(
        `turn ${turn.turn}: position PARKED on step ${trackedStep} for ${
          consecutiveSameStep + 1
        } turns while conversation advanced to ${turn.aiStepNumber}`
      );
    }
  }

  // Final-step check
  const finalTracked = traces.at(-1)?.trackedStep ?? 0;
  if (
    typeof fixture.checks.finalStepAtLeast === 'number' &&
    finalTracked < fixture.checks.finalStepAtLeast
  ) {
    failures.push(
      `final tracked step ${finalTracked} < finalStepAtLeast ${fixture.checks.finalStepAtLeast} — conversation never advanced to terminal`
    );
  }

  return { passed: failures.length === 0, traces, failures };
}
