'use client';

// /dashboard/traces — self-serve generation-trace viewer (2026-07-25).
// Built for verification runs: paste a conversation ID and see every AI turn's
// branch_selected, stage_emitted, variables_state, quality hard fails, and
// (per turn, on demand) the full prompt_sent. Backed by
// GET /api/conversations/[id]/traces — account-scoped, platform operators see all.

import { useState } from 'react';

interface TraceTurn {
  turn: number;
  createdAt: string;
  step: number | null;
  system_stage: string | null;
  stage_emitted: string | null;
  sub_stage_emitted: string | null;
  branch_selected: string | null;
  variables_state: Array<{
    name: string;
    value: unknown;
    source: string;
    confidence?: string;
  }> | null;
  reply_preview: string | null;
  quality_hard_fails: string[] | null;
  prompt_chars: number | null;
  prompt_sent?: string | null;
}

interface TraceResponse {
  conversationId: string;
  lead: string | null;
  finalState: {
    step: number | null;
    systemStage: string | null;
    awaitingHumanReview: boolean;
    distressDetected: boolean;
  };
  capturedVariables: Record<
    string,
    { value: unknown; method: string | null; confidence: string | null }
  >;
  turnCount: number;
  turns: TraceTurn[];
}

export default function TracesPage() {
  const [convId, setConvId] = useState('');
  const [data, setData] = useState<TraceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [promptOpen, setPromptOpen] = useState<Record<number, string>>({});

  async function load() {
    const id = convId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    setData(null);
    setPromptOpen({});
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(id)}/traces`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function loadPrompt(turn: number) {
    if (!data) return;
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(data.conversationId)}/traces?prompt=${turn}`
      );
      const json: TraceResponse = await res.json();
      const p = json.turns?.[turn]?.prompt_sent;
      setPromptOpen((prev) => ({
        ...prev,
        [turn]: p || '(no prompt recorded)'
      }));
    } catch {
      setPromptOpen((prev) => ({ ...prev, [turn]: '(failed to load prompt)' }));
    }
  }

  return (
    <div className='mx-auto max-w-5xl space-y-6 p-6'>
      <div>
        <h1 className='text-2xl font-semibold'>Generation Traces</h1>
        <p className='text-muted-foreground mt-1 text-sm'>
          Per-turn engine trace for verification: branch selected, stage emitted
          vs computed, variable bindings with source, quality gate hard fails,
          and the exact prompt sent.
        </p>
      </div>

      <div className='flex gap-2'>
        <input
          className='flex-1 rounded-md border px-3 py-2 font-mono text-sm'
          placeholder='Conversation ID (e.g. cmrzgulcs000rjm047g6w3t7q)'
          value={convId}
          onChange={(e) => setConvId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        <button
          onClick={load}
          disabled={loading || !convId.trim()}
          className='bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm disabled:opacity-50'
        >
          {loading ? 'Loading…' : 'Load traces'}
        </button>
      </div>

      {error && (
        <div className='rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800'>
          {error}
        </div>
      )}

      {data && (
        <>
          <div className='space-y-1 rounded-md border p-4 text-sm'>
            <div>
              <span className='font-medium'>{data.lead ?? 'Unknown lead'}</span>{' '}
              · <span className='font-mono text-xs'>{data.conversationId}</span>
            </div>
            <div>
              Final: step {data.finalState.step} · {data.finalState.systemStage}{' '}
              · awaitingHuman=
              {String(data.finalState.awaitingHumanReview)} · distress=
              {String(data.finalState.distressDetected)} · {data.turnCount}{' '}
              turns
            </div>
          </div>

          <div className='rounded-md border p-4'>
            <h2 className='mb-2 text-sm font-semibold'>
              Final captured variables
            </h2>
            <table className='w-full text-xs'>
              <thead>
                <tr className='text-muted-foreground text-left'>
                  <th className='py-1 pr-4'>variable</th>
                  <th className='py-1 pr-4'>value</th>
                  <th className='py-1 pr-4'>method</th>
                  <th className='py-1'>confidence</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.capturedVariables).map(([k, v]) => (
                  <tr key={k} className='border-t'>
                    <td className='py-1 pr-4 font-mono'>{k}</td>
                    <td className='py-1 pr-4'>
                      {JSON.stringify(v.value)?.slice(0, 100)}
                    </td>
                    <td className='py-1 pr-4'>{v.method ?? '—'}</td>
                    <td className='py-1'>{v.confidence ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className='space-y-4'>
            {data.turns.map((t) => (
              <div key={t.turn} className='rounded-md border p-4 text-sm'>
                <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
                  <span className='font-semibold'>Turn {t.turn}</span>
                  <span className='text-muted-foreground text-xs'>
                    {new Date(t.createdAt).toLocaleString()}
                  </span>
                  <span className='bg-muted rounded px-1.5 py-0.5 text-xs'>
                    step {t.step ?? '—'}
                  </span>
                  <span className='bg-muted rounded px-1.5 py-0.5 text-xs'>
                    system: {t.system_stage ?? '—'}
                  </span>
                  <span className='bg-muted rounded px-1.5 py-0.5 text-xs'>
                    emitted: {t.stage_emitted ?? '—'}
                    {t.sub_stage_emitted ? `/${t.sub_stage_emitted}` : ''}
                  </span>
                  <span className='bg-muted rounded px-1.5 py-0.5 text-xs'>
                    branch: {t.branch_selected ?? '—'}
                  </span>
                </div>

                {t.reply_preview && (
                  <p className='mt-2 text-sm'>
                    <span className='text-muted-foreground'>reply:</span>{' '}
                    {t.reply_preview}
                  </p>
                )}

                {Array.isArray(t.variables_state) &&
                  t.variables_state.length > 0 && (
                    <div className='mt-2'>
                      <div className='text-muted-foreground text-xs font-medium'>
                        variables_state
                      </div>
                      <ul className='mt-1 space-y-0.5 text-xs'>
                        {t.variables_state.map((v, i) => (
                          <li key={i} className='font-mono'>
                            {v.name} = {JSON.stringify(v.value)?.slice(0, 80)}{' '}
                            <span className='text-muted-foreground'>
                              [{v.source}
                              {v.confidence ? `/${v.confidence}` : ''}]
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                {Array.isArray(t.quality_hard_fails) &&
                  t.quality_hard_fails.length > 0 && (
                    <div className='mt-2'>
                      <div className='text-xs font-medium text-red-600'>
                        quality hard fails
                      </div>
                      <ul className='mt-1 space-y-0.5 text-xs text-red-700'>
                        {t.quality_hard_fails.map((f, i) => (
                          <li key={i}>{String(f).slice(0, 220)}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                <div className='mt-2'>
                  {promptOpen[t.turn] !== undefined ? (
                    <details open>
                      <summary className='text-muted-foreground cursor-pointer text-xs'>
                        prompt_sent ({t.prompt_chars ?? '?'} chars)
                      </summary>
                      <pre className='bg-muted mt-2 max-h-96 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap'>
                        {promptOpen[t.turn]}
                      </pre>
                    </details>
                  ) : (
                    <button
                      onClick={() => loadPrompt(t.turn)}
                      className='text-xs text-blue-600 underline'
                    >
                      show prompt_sent ({t.prompt_chars ?? '?'} chars)
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
