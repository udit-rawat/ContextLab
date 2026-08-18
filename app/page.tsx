import {
  ANSWER_MODEL,
  EMBED_MODEL,
  EMBED_DIMENSIONS,
  JUDGE_MODEL,
  CONTEXT_TOKEN_CAP,
  CORPUS,
  STRATEGIES,
  PRICING,
} from '@/config/models';

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16 flex-1">
      <h1 className="text-3xl font-semibold tracking-tight">Context Lab</h1>
      <p className="mt-3 text-base/7 opacity-80">
        Superbrain claims a 60&ndash;80% token reduction with no loss of repository awareness. This
        is the harness that measures a claim like that: one question, four context strategies, real
        token counts, real cost, scored answers.
      </p>

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wider opacity-60">Strategies</h2>
        <ol className="mt-4 space-y-3">
          {Object.entries(STRATEGIES).map(([id, s], i) => (
            <li key={id} className="flex gap-3">
              <span className="font-mono text-sm opacity-40 tabular-nums">{i + 1}</span>
              <div>
                <span className="font-medium">{s.label}</span>
                <p className="text-sm opacity-70">{s.blurb}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wider opacity-60">Pinned setup</h2>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="opacity-60">Corpus</dt>
          <dd className="font-mono">
            fastapi/{CORPUS.commit.slice(0, 7)} &middot; {CORPUS.include}
          </dd>
          <dt className="opacity-60">Answerer</dt>
          <dd className="font-mono">
            {ANSWER_MODEL} &middot; ${PRICING[ANSWER_MODEL].inputPerM}/M in
          </dd>
          <dt className="opacity-60">Embeddings</dt>
          <dd className="font-mono">
            {EMBED_MODEL} @ {EMBED_DIMENSIONS}d
          </dd>
          <dt className="opacity-60">Judge</dt>
          <dd className="font-mono">{JUDGE_MODEL}</dd>
          <dt className="opacity-60">Context cap</dt>
          <dd className="font-mono">{CONTEXT_TOKEN_CAP.toLocaleString()} tokens</dd>
        </dl>
      </section>

      <p className="mt-10 text-sm opacity-50">
        Benchmark results and the live query view land here as the build progresses.
      </p>
    </main>
  );
}
