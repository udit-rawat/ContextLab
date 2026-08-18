'use client';

import { useState } from 'react';

/**
 * Live mode. Fires one request per strategy in parallel and fills each card as
 * it lands, so a slow or failing strategy never blocks the others.
 */

type Result =
  | {
      ok: true;
      strategy: string;
      label: string;
      answer: string;
      citedFiles: string[];
      promptTokens: number;
      costUsd: number;
      latencyMs: number;
      cached: boolean;
    }
  | { ok: false; strategy: string; label: string; error: string };

const STRATEGIES = [
  { id: 'full-stuff', label: 'Full stuffing' },
  { id: 'top-k', label: 'Top-8 vector' },
  { id: 'rerank', label: 'Retrieve + rerank' },
  { id: 'skeleton', label: 'Structure-aware' },
];

const EXAMPLES = [
  'How does FastAPI validate request bodies?',
  'What does APIRouter.include_router do?',
  'How are background tasks executed?',
];

export function LiveQuery() {
  const [question, setQuestion] = useState('');
  const [results, setResults] = useState<Record<string, Result | null>>({});
  const [running, setRunning] = useState(false);

  async function run(q: string) {
    const trimmed = q.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setResults(Object.fromEntries(STRATEGIES.map((s) => [s.id, null])));

    await Promise.all(
      STRATEGIES.map(async (s) => {
        try {
          const res = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: trimmed, strategy: s.id }),
          });
          const json = await res.json();
          setResults((prev) => ({
            ...prev,
            [s.id]: res.ok
              ? { ok: true, ...json }
              : { ok: false, strategy: s.id, label: s.label, error: json.error ?? 'Request failed' },
          }));
        } catch {
          setResults((prev) => ({ ...prev, [s.id]: { ok: false, strategy: s.id, label: s.label, error: 'Network error' } }));
        }
      }),
    );
    setRunning(false);
  }

  const started = Object.keys(results).length > 0;

  return (
    <div>
      <form
        onSubmit={(e) => { e.preventDefault(); void run(question); }}
        className="flex flex-col gap-3 sm:flex-row"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder="Ask something about the FastAPI source…"
          className="flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none placeholder:opacity-50 focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
        />
        <button
          type="submit"
          disabled={running || !question.trim()}
          className="rounded-md border border-black/20 px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-40 dark:border-white/25"
        >
          {running ? 'Running all four…' : 'Run all four'}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="opacity-50">Try:</span>
        {EXAMPLES.map((e) => (
          <button key={e} onClick={() => { setQuestion(e); void run(e); }} disabled={running}
                  className="underline underline-offset-2 opacity-70 hover:opacity-100 disabled:opacity-30">
            {e}
          </button>
        ))}
      </div>

      {started && (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {STRATEGIES.map((s) => {
            const r = results[s.id];
            return (
              <div key={s.id} className="rounded-md border border-black/10 p-4 dark:border-white/15">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{s.label}</span>
                  {r?.ok && (
                    <span className="font-mono text-xs opacity-60 tabular-nums">
                      {r.promptTokens.toLocaleString()}t · ${r.costUsd.toFixed(5)} · {(r.latencyMs / 1000).toFixed(1)}s
                      {r.cached ? ' · cached' : ''}
                    </span>
                  )}
                </div>
                {!r && <p className="mt-3 text-sm opacity-50">Running…</p>}
                {r && !r.ok && <p className="mt-3 text-sm opacity-70">{r.error}</p>}
                {r?.ok && (
                  <>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 opacity-90">
                      {r.answer.replace(/^\s*FILES:.*$/gim, '').trim()}
                    </p>
                    <p className="mt-3 font-mono text-xs opacity-60">
                      cited: {r.citedFiles.length ? r.citedFiles.join(', ') : '(none)'}
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
