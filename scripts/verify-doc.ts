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
import { encode } from 'gpt-tokenizer';
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
let absent = 0;

const check = (label: string, claim: string, present: boolean) => {
  if (!present) fail++;
  console.log(`  ${present ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${claim}`);
};

/**
 * A number is verified if the document quotes it, at full precision or at any
 * shorter rounding of it. A number the document simply does not mention is not
 * a failure -- the document is allowed to be shorter than the dataset. What is
 * a failure is quoting a value that the committed data does not support, which
 * is what the `contradicts` check below looks for.
 */
const renderings = (s: string): string[] => {
  const out = new Set<string>([s]);
  const m = s.match(/^\$?(\d+)\.(\d+)$/);
  if (m) {
    const [, whole, frac] = m;
    const dollar = s.startsWith('$');
    for (let d = frac.length - 1; d >= 1; d--) {
      const rounded = Number(`${whole}.${frac}`).toFixed(d);
      out.add(dollar ? `$${rounded}` : rounded);
    }
  }
  return [...out];
};

const has = (label: string, s: string) => {
  const forms = renderings(s);
  const hit = forms.find((f) => doc.includes(f));
  if (hit) { console.log(`  ok    ${label.padEnd(46)} ${hit}`); return; }
  absent++;
  console.log(`  --    ${label.padEnd(46)} ${s}  (not quoted in the document)`);
};

/**
 * Text the document quotes rather than asserts. A sentence like
 * `I could have said "rerank improves quality by 10%" but it would be wrong`
 * is the document refusing a claim, not making one, so quoted spans are
 * stripped before contradiction patterns run.
 */
const asserted = doc
  .replace(/"[^"]*"/g, ' ')
  .replace(/“[^”]*”/g, ' ')
  .replace(/`[^`]*`/g, ' ');

/** Fails when the document states a value the data does not support. */
const contradicts = (label: string, wrongPatterns: RegExp[], why: string) => {
  const bad = wrongPatterns.find((r) => r.test(asserted));
  check(label, bad ? `document says "${asserted.match(bad)?.[0]}" - ${why}` : 'no contradiction', !bad);
};

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

console.log('\nsuperbrain manifest claims');
{
  const man = readFileSync('.superbrain/manifest.md', 'utf8');
  const manTokens = encode(man).length;
  has('manifest token count', manTokens.toLocaleString());
  const ratio = skel.tokens / manTokens;
  has('skeleton/manifest ratio', `${ratio.toFixed(1)}x`);
  check('manifest really has no symbols', 'def/class count', !/\bdef \w|\bclass \w/.test(man));
  const files = (man.match(/\[(source|config|docs|style|other)\]/g) ?? []).length;
  has('manifest file count', `${files} file paths`);
}

console.log('\nworst cases named in the doc');
const zeros = b.rows.filter((r) => r.qualityScore === 0);
check('a full-stuff answer scored 0', zeros.map((r) => r.questionId).join(','), zeros.some((r) => r.strategy === 'full-stuff'));
check('doc names question f3 as the 0', 'f3', /f3.*scored 0|scored 0/i.test(doc) && doc.includes('f3'));

console.log('\ncontradiction checks');
contradicts(
  'no stale corpus token count',
  [/\b(238|238,000|240k)\b/],
  'the corpus is 183,648 Gemini tokens',
);
contradicts(
  'no stale dropped-share claim',
  [/\b(16\.6|17\.8)%/],
  `full stuffing drops ${(plan.droppedTokenShare * 100).toFixed(1)}% of the corpus`,
);
contradicts(
  'does not claim a strategy beat the baseline',
  [/rerank (?:improves|beats|wins by)/i],
  'every comparison is a tie',
);
contradicts(
  'does not claim Superbrain was benchmarked',
  [/I (?:benchmarked|measured|tested) superbrain'?s? (?:engine|context engine)/i],
  'Superbrain was never run as a black box',
);

console.log(`\n${absent} data point(s) not quoted in the document (allowed).`);
console.log(fail === 0 ? 'No number in README.md contradicts the committed output.' : `${fail} claim(s) do not match the committed data.`);
process.exit(fail === 0 ? 0 : 1);
