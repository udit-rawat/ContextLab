/**
 * Turns results/benchmark.json into the numbers the writeup quotes.
 *
 * Order matters here and is deliberate: the within-strategy spread is computed
 * and printed BEFORE any strategy is compared to another. A mean difference
 * smaller than that spread is reported as a tie, not as an improvement.
 *
 *   npx tsx scripts/analyze.ts
 */
import { readFileSync } from 'node:fs';
import { aggregate, isTie, paretoFrontier, type Benchmark } from '../lib/results';
import { STRATEGIES, BASELINE_STRATEGY, type StrategyId } from '../config/models';

const ORDER: StrategyId[] = ['full-stuff', 'top-k', 'rerank', 'skeleton'];
const b = JSON.parse(readFileSync('results/benchmark.json', 'utf8')) as Benchmark;
const aggs = ORDER.map((s) => aggregate(b.rows, s));
const base = aggs.find((a) => a.strategy === BASELINE_STRATEGY)!;
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const rpad = (s: unknown, n: number) => String(s).padStart(n);

console.log(`questions ${new Set(b.rows.map((r) => r.questionId)).size}  ·  rows ${b.rows.length}  ·  answerer ${b.answerModel}  ·  judge ${b.judgeModel}\n`);

console.log('STEP 1 — within-strategy spread, computed before any comparison');
for (const a of aggs) {
  console.log(`  ${pad(STRATEGIES[a.strategy].label, 18)} mean ${a.meanQuality!.toFixed(2)}  sd ${a.sdQuality!.toFixed(2)}`);
}
const pooledAll = Math.sqrt(aggs.reduce((n, a) => n + a.sdQuality! ** 2, 0) / aggs.length);
console.log(`  pooled sd across strategies: ${pooledAll.toFixed(2)}`);
console.log(`  => any gap in mean quality below the pooled sd of the pair is a TIE\n`);

console.log('STEP 2 — per strategy');
console.log(`  ${pad('strategy', 18)} ${rpad('tokens', 8)} ${rpad('cost', 10)} ${rpad('vs base', 8)} ${rpad('latency', 9)} ${rpad('quality', 8)} ${rpad('sd', 6)} ${rpad('cite P', 7)} ${rpad('cite R', 7)}`);
for (const a of aggs) {
  console.log(
    `  ${pad(STRATEGIES[a.strategy].label, 18)} ${rpad(Math.round(a.meanPromptTokens).toLocaleString(), 8)} ${rpad('$' + a.meanCostUsd.toFixed(6), 10)} ${rpad((a.meanCostUsd / base.meanCostUsd).toFixed(1) + 'x', 8)} ${rpad((a.meanLatencyMs / 1000).toFixed(1) + 's', 9)} ${rpad(a.meanQuality!.toFixed(2), 8)} ${rpad(a.sdQuality!.toFixed(2), 6)} ${rpad((a.meanCitationPrecision! * 100).toFixed(0) + '%', 7)} ${rpad((a.meanCitationRecall! * 100).toFixed(0) + '%', 7)}`,
  );
}

console.log(`\nSTEP 3 — comparison against the fair baseline (${STRATEGIES[BASELINE_STRATEGY].label})`);
for (const a of aggs) {
  if (a.strategy === BASELINE_STRATEGY) continue;
  const diff = a.meanQuality! - base.meanQuality!;
  const pooled = Math.sqrt((a.sdQuality! ** 2 + base.sdQuality! ** 2) / 2);
  const tie = isTie(a, base);
  const verdict = tie ? 'TIE' : diff > 0 ? 'BETTER' : 'WORSE';
  console.log(
    `  ${pad(STRATEGIES[a.strategy].label, 18)} quality ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}  (pooled sd ${pooled.toFixed(2)})  -> ${verdict}   cost ${(a.meanCostUsd / base.meanCostUsd).toFixed(1)}x`,
  );
}

console.log('\nSTEP 4 — Pareto frontier (quality vs cost)');
const front = paretoFrontier(aggs);
console.log(`  on frontier: ${front.map((s) => STRATEGIES[s].label).join(', ')}`);
console.log(`  dominated  : ${aggs.filter((a) => !front.includes(a.strategy)).map((a) => STRATEGIES[a.strategy].label).join(', ') || '(none)'}`);

console.log('\nSTEP 5 — by question type');
for (const type of ['factual', 'cross-file', 'architectural'] as const) {
  const rows = b.rows.filter((r) => r.type === type);
  console.log(`  ${pad(type, 14)} n=${new Set(rows.map((r) => r.questionId)).size}`);
  for (const s of ORDER) {
    const a = aggregate(rows, s);
    console.log(`    ${pad(STRATEGIES[s].label, 18)} quality ${a.meanQuality!.toFixed(2)}  cite P ${(a.meanCitationPrecision! * 100).toFixed(0)}%`);
  }
}

console.log('\nSTEP 6 — where the two metrics disagree');
for (const s of ORDER) {
  const a = aggregate(b.rows, s);
  console.log(`  ${pad(STRATEGIES[s].label, 18)} quality ${(a.meanQuality! / 5 * 100).toFixed(0)}% of max · citation precision ${(a.meanCitationPrecision! * 100).toFixed(0)}%`);
}

console.log('\nSTEP 7 — worst cases (quality <= 1)');
for (const r of b.rows.filter((x) => (x.qualityScore ?? 5) <= 1)) {
  console.log(`  ${pad(r.questionId, 4)} ${pad(STRATEGIES[r.strategy].label, 18)} score ${r.qualityScore}  ${r.judgeRationale?.slice(0, 90)}`);
}
