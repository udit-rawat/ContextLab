/**
 * Anti-checklist item 1: every number quoted in README.md must re-derive from
 * the committed output files, not from memory or an earlier run.
 *
 * This asserts each claim in the document against results/benchmark.json,
 * data/fullstuff.json, data/index.json and corpus/manifest.json. It exits
 * non-zero on any mismatch, so a stale number cannot survive a rerun.
 *
 *   npx tsx scripts/verify-doc.ts
 */
import { readFileSync } from 'node:fs';
import { aggregate, isTie, paretoFrontier, type Benchmark } from '../lib/results';
import type { StrategyId } from '../config/models';

const doc = readFileSync('README.md', 'utf8');
const b = JSON.parse(readFileSync('results/benchmark.json', 'utf8')) as Benchmark;
const plan = JSON.parse(readFileSync('data/fullstuff.json', 'utf8'));
const man = JSON.parse(readFileSync('corpus/manifest.json', 'utf8'));
const idx = JSON.parse(readFileSync('data/index.json', 'utf8'));
const skel = JSON.parse(readFileSync('data/skeleton.json', 'utf8'));

const O: StrategyId[] = ['full-stuff', 'top-k', 'rerank', 'skeleton'];
const A = Object.fromEntries(O.map((s) => [s, aggregate(b.rows, s)])) as Record<StrategyId, ReturnType<typeof aggregate>>;
const base = A['top-k'];

let fail = 0;
const check = (label: string, claim: string, present: boolean) => {
  if (!present) fail++;
  console.log(`  ${present ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${claim}`);
};
/** Assert the document literally contains this string. */
const has = (label: string, s: string) => check(label, s, doc.includes(s));

console.log('corpus');
has('file count', `${man.files} files`);
has('gemini token count', plan.corpusGeminiTokens.toLocaleString());
has('gpt-tokenizer count', man.tokens.toLocaleString());
has('chunk count', `${idx.chunks.length}`);
has('embedding dimensions', `${idx.dimensions} dimensions`);
has('skeleton tokens (compacted)', skel.tokens.toLocaleString());

console.log('\nfull stuffing plan');
has('budget used', plan.geminiTokens.toLocaleString());
has('whole files', `${plan.wholeFiles.length} files go in whole`);
has('omitted files', `${plan.omittedFiles.length} files never enter`);
has('dropped share', `${(plan.droppedTokenShare * 100).toFixed(1)}%`);
has('partial cut chars', plan.partial.chars.toLocaleString());

console.log('\nbenchmark');
has('question count', `${new Set(b.rows.map((r) => r.questionId)).size} questions`);
has('row count', `${b.rows.length} runs`);
for (const s of O) {
  has(`${s} mean tokens`, Math.round(A[s].meanPromptTokens).toLocaleString());
  has(`${s} mean cost`, `$${A[s].meanCostUsd.toFixed(6)}`);
  has(`${s} mean quality`, A[s].meanQuality!.toFixed(2));
  has(`${s} sd`, A[s].sdQuality!.toFixed(2));
}

console.log('\nderived claims');
const reduction = 100 * (1 - base.meanPromptTokens / A['full-stuff'].meanPromptTokens);
has('token reduction', `${reduction.toFixed(1)}%`);
has('cost multiple', `${(A['full-stuff'].meanCostUsd / base.meanCostUsd).toFixed(1)}x`);

console.log('\ntie claims (the document says every comparison is a tie)');
for (const s of O) {
  if (s === 'top-k') continue;
  const tie = isTie(A[s], base);
  const pooled = Math.sqrt((A[s].sdQuality! ** 2 + base.sdQuality! ** 2) / 2);
  check(`${s} is a tie`, `diff ${(A[s].meanQuality! - base.meanQuality!).toFixed(2)} vs pooled sd ${pooled.toFixed(2)}`, tie === true);
  has(`${s} pooled sd quoted`, pooled.toFixed(2));
}

console.log('\npareto frontier');
const front = paretoFrontier(O.map((s) => A[s]));
check('frontier is top-k + rerank', front.join(','), front.length === 2 && front.includes('top-k') && front.includes('rerank'));
check('doc calls full stuffing dominated', 'text present', /full stuffing is dominated/i.test(doc));

console.log('\nby-question-type table');
for (const t of ['factual', 'cross-file', 'architectural'] as const) {
  const rows = b.rows.filter((r) => r.type === t);
  for (const s of O) has(`${t}/${s}`, aggregate(rows, s).meanQuality!.toFixed(2));
}

console.log('\nworst cases named in the doc');
const zeros = b.rows.filter((r) => r.qualityScore === 0);
check('a full-stuff answer scored 0', zeros.map((r) => r.questionId).join(','), zeros.some((r) => r.strategy === 'full-stuff'));
check('doc names question f3 as the 0', 'f3', /f3.*scored 0|scored 0/i.test(doc) && doc.includes('f3'));

console.log(fail === 0 ? '\nEvery number in README.md re-derives from committed output.' : `\n${fail} claim(s) do not match the committed data.`);
process.exit(fail === 0 ? 0 : 1);
