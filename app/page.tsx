import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParetoChart, type ChartPoint } from '@/components/ParetoChart';
import { LiveQuery } from '@/components/LiveQuery';
import { aggregate, paretoFrontier, hasQualityScores, isTie, type Benchmark } from '@/lib/results';
import {
  ANSWER_MODEL, EMBED_MODEL, EMBED_DIMENSIONS, JUDGE_MODEL,
  CONTEXT_TOKEN_CAP, CORPUS, STRATEGIES, PRICING, BASELINE_STRATEGY, type StrategyId,
} from '@/config/models';

const ORDER: StrategyId[] = ['full-stuff', 'top-k', 'rerank', 'skeleton'];

function load(): { benchmark: Benchmark; plan: { corpusGeminiTokens: number; omittedFiles: string[]; droppedTokenShare: number; wholeFiles: string[]; partial: { file: string; chars: number } | null } } {
  const root = process.cwd();
  return {
    benchmark: JSON.parse(readFileSync(join(root, 'results', 'benchmark.json'), 'utf8')),
    plan: JSON.parse(readFileSync(join(root, 'data', 'fullstuff.json'), 'utf8')),
  };
}

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`;
const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(0)}%`);

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border-l border-black/15 pl-4 dark:border-white/20">
      <dt className="text-xs uppercase tracking-wider opacity-55">{label}</dt>
      <dd className="mt-1 font-mono text-2xl tabular-nums">{value}</dd>
      {note && <dd className="mt-0.5 text-xs opacity-55">{note}</dd>}
    </div>
  );
}

export default function Home() {
  const { benchmark, plan } = load();
  const aggs = ORDER.map((s) => aggregate(benchmark.rows, s));
  const scored = hasQualityScores(benchmark);
  const baseline = aggs.find((a) => a.strategy === BASELINE_STRATEGY)!;
  const full = aggs.find((a) => a.strategy === 'full-stuff')!;
  // Frontier is computed on whichever metric the vertical axis is actually
  // showing, so the dashed line never claims more than the data supports.
  const frontier = new Set(
    paretoFrontier(aggs, (a) => (hasQualityScores(benchmark) ? a.meanQuality : a.meanCitationPrecision)),
  );

  // Until the rubric judge has run, citation precision is the quality axis: it
  // is a measured signal, not a placeholder, and the axis swaps to the rubric
  // score once scores exist.
  const yKey = scored ? 'quality' : 'precision';
  const yLabel = scored ? 'answer quality (judge rubric, 0–5)' : 'citation precision (share of cited files that were correct)';
  const yMax = scored ? 5 : 1;

  const points: ChartPoint[] = aggs.map((a) => {
    const y = yKey === 'quality' ? (a.meanQuality ?? 0) : (a.meanCitationPrecision ?? 0);
    return {
      strategy: a.strategy,
      label: STRATEGIES[a.strategy].label,
      cost: a.meanCostUsd,
      quality: y,
      detail: `${usd(a.meanCostUsd)} · ${yMax === 1 ? pct(y) : y.toFixed(2)}`,
      onFrontier: frontier.has(a.strategy),
    };
  });

  const costMultiple = full.meanCostUsd / baseline.meanCostUsd;
  const questionCount = new Set(benchmark.rows.map((r) => r.questionId)).size;
  const tieVsBaseline = aggs.map((a) => ({ strategy: a.strategy, tie: isTie(a, baseline) }));

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-14">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Context Lab</h1>
        <p className="mt-3 max-w-2xl text-base/7 opacity-80">
          Superbrain claims a 60–80% token reduction with no loss of repository awareness. This is
          the harness that measures a claim like that: one question, four context strategies, real
          token counts from the provider&rsquo;s own tokenizer, real cost, scored answers.
        </p>
      </header>

      <dl className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Corpus" value={`${(benchmark.corpusTokens / 1000).toFixed(0)}k`} note="Gemini tokens, 48 files" />
        <Stat label="Full stuff cost" value={`${costMultiple.toFixed(0)}×`} note={`vs ${STRATEGIES[BASELINE_STRATEGY].label} baseline`} />
        <Stat label="Repo unseen" value={pct(plan.droppedTokenShare)} note="dropped by full stuffing" />
        <Stat label="Files omitted" value={String(plan.omittedFiles.length)} note="never enter the window" />
      </dl>

      <section className="mt-14">
        <h2 className="text-lg font-medium">Cost against quality</h2>
        <p className="mt-2 max-w-2xl text-sm opacity-70">
          {scored
            ? 'Judge rubric score against measured cost per query.'
            : 'Rubric scoring lands with the full golden set. Until then the vertical axis is citation precision — a measured signal, not a placeholder.'}
        </p>
        <p className="mt-2 max-w-2xl text-sm opacity-55">
          Based on {questionCount} question{questionCount === 1 ? '' : 's'} ({benchmark.rows.length} runs). That is too few to
          separate strategies on quality with any confidence — the cost axis is already solid, the
          vertical axis is directional until the full golden set runs.
        </p>
        <div className="mt-5">
          <ParetoChart points={points} yLabel={yLabel} yMax={yMax} />
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-lg font-medium">Per strategy</h2>
        <p className="mt-2 text-sm opacity-70">
          Improvements are measured against <strong>{STRATEGIES[BASELINE_STRATEGY].label}</strong> — what a competent
          engineer builds by default. Full stuffing establishes the cost ceiling, not the comparison point.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/15 text-left dark:border-white/20">
                <th className="py-2 pr-4 font-medium">Strategy</th>
                <th className="py-2 pr-4 text-right font-medium">Context</th>
                <th className="py-2 pr-4 text-right font-medium">Cost</th>
                <th className="py-2 pr-4 text-right font-medium">vs base</th>
                <th className="py-2 pr-4 text-right font-medium">Latency</th>
                <th className="py-2 pr-4 text-right font-medium">Cite prec.</th>
                <th className="py-2 text-right font-medium">Quality</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {aggs.map((a) => (
                <tr key={a.strategy} className="border-b border-black/8 dark:border-white/10">
                  <td className="py-2 pr-4 font-sans">
                    {STRATEGIES[a.strategy].label}
                    {a.strategy === BASELINE_STRATEGY && <span className="ml-2 text-xs opacity-50">baseline</span>}
                  </td>
                  <td className="py-2 pr-4 text-right">{Math.round(a.meanPromptTokens).toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right">{usd(a.meanCostUsd)}</td>
                  <td className="py-2 pr-4 text-right">{(a.meanCostUsd / baseline.meanCostUsd).toFixed(1)}×</td>
                  <td className="py-2 pr-4 text-right">{(a.meanLatencyMs / 1000).toFixed(1)}s</td>
                  <td className="py-2 pr-4 text-right">{pct(a.meanCitationPrecision)}</td>
                  <td className="py-2 text-right">{a.meanQuality === null ? '—' : a.meanQuality.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs opacity-55">
          {scored
            ? tieVsBaseline.filter((t) => t.tie).map((t) => STRATEGIES[t.strategy].label).join(', ') +
              ' are within the within-strategy spread of the baseline and are reported as ties.'
            : 'Tie testing activates once rubric scores exist: any gap smaller than the question-to-question spread within a strategy is reported as a tie, not an improvement.'}
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-lg font-medium">What made it into the window</h2>
        <p className="mt-2 max-w-2xl text-sm opacity-70">
          Full stuffing fills the {CONTEXT_TOKEN_CAP.toLocaleString()}-token cap and still cannot
          see {pct(plan.droppedTokenShare)} of the repository. These {plan.omittedFiles.length} files never enter its context at all:
        </p>
        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs opacity-70">
          {plan.omittedFiles.map((f) => <li key={f}>{f}</li>)}
        </ul>
        <p className="mt-4 max-w-2xl text-sm opacity-70">
          <code className="font-mono text-xs">{plan.partial?.file}</code> is cut mid-file. Retrieval strategies
          reach every one of these, because they select on relevance rather than on where a file
          happens to sit in path order.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-lg font-medium">Ask your own question</h2>
        <p className="mt-2 max-w-2xl text-sm opacity-70">
          Runs live against the same index, one request per strategy so nothing hits a function
          timeout. Results above are precomputed and committed — they do not depend on this working.
        </p>
        <div className="mt-5"><LiveQuery /></div>
      </section>

      <section className="mt-14 border-t border-black/10 pt-8 dark:border-white/15">
        <h2 className="text-lg font-medium">Pinned setup</h2>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="opacity-60">Corpus</dt>
          <dd className="font-mono">fastapi/{CORPUS.commit.slice(0, 7)} · {CORPUS.include} · {benchmark.corpusTokens.toLocaleString()} tokens</dd>
          <dt className="opacity-60">Answerer</dt>
          <dd className="font-mono">{ANSWER_MODEL} · ${PRICING[ANSWER_MODEL].inputPerM}/M in · ${PRICING[ANSWER_MODEL].outputPerM}/M out</dd>
          <dt className="opacity-60">Embeddings</dt>
          <dd className="font-mono">{EMBED_MODEL} @ {EMBED_DIMENSIONS}d</dd>
          <dt className="opacity-60">Judge</dt>
          <dd className="font-mono">{JUDGE_MODEL} · different family from the answerer</dd>
          <dt className="opacity-60">Context cap</dt>
          <dd className="font-mono">{CONTEXT_TOKEN_CAP.toLocaleString()} tokens, applied to every strategy</dd>
          <dt className="opacity-60">Questions</dt>
          <dd className="font-mono">{new Set(benchmark.rows.map((r) => r.questionId)).size} · {benchmark.rows.length} runs</dd>
        </dl>
        <p className="mt-5 max-w-2xl text-xs opacity-55">
          Benchmark run {new Date(benchmark.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.
          Costs are published list prices applied to measured token counts; the run itself executed on
          free tier. Token counts come from the provider&rsquo;s usage metadata, not an estimate.
        </p>
      </section>
    </main>
  );
}
