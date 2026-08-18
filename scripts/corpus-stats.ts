/**
 * Measures the corpus before anything is embedded: chunk distribution and, more
 * importantly, the skeleton size. Strategy 4's entire economic case rests on the
 * skeleton being cheap relative to the repo, so this number decides whether that
 * strategy is interesting or a foregone conclusion.
 *
 *   npx tsx scripts/corpus-stats.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { encode } from 'gpt-tokenizer';
import { chunkPythonFile } from '../lib/chunker';
import { buildSkeleton } from '../lib/skeleton';
import { CONTEXT_TOKEN_CAP, MAX_CHUNK_TOKENS, TOP_K } from '../config/models';

const CORPUS = join(process.cwd(), 'corpus');
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.py')) out.push(p);
  }
  return out;
};

const files = walk(CORPUS).sort().map((abs) => ({ file: relative(CORPUS, abs), source: readFileSync(abs, 'utf8') }));

const allChunks = files.flatMap((f) => chunkPythonFile(f.file, f.source));
const corpusTokens = files.reduce((n, f) => n + encode(f.source).length, 0);
const skeleton = buildSkeleton(files);

const sizes = allChunks.map((c) => c.tokens).sort((a, b) => a - b);
const pct = (p: number) => sizes[Math.floor((sizes.length - 1) * p)];
const oversized = sizes.filter((t) => t > MAX_CHUNK_TOKENS).length;

console.log(`corpus`);
console.log(`  files            ${files.length}`);
console.log(`  tokens           ${corpusTokens.toLocaleString()}`);
console.log(`  context cap      ${CONTEXT_TOKEN_CAP.toLocaleString()}`);
console.log(`  fits in cap?     ${corpusTokens <= CONTEXT_TOKEN_CAP ? 'yes' : `NO - full stuffing truncates ${(((corpusTokens - CONTEXT_TOKEN_CAP) / corpusTokens) * 100).toFixed(1)}%`}`);

console.log(`\nchunks`);
console.log(`  count            ${allChunks.length}`);
console.log(`  median tokens    ${pct(0.5)}`);
console.log(`  p90 / p99        ${pct(0.9)} / ${pct(0.99)}`);
console.log(`  max              ${sizes[sizes.length - 1]}`);
console.log(`  over budget      ${oversized} (${((oversized / sizes.length) * 100).toFixed(1)}%)`);
console.log(`  by kind          ` + ['function', 'class', 'module'].map((k) => `${k}=${allChunks.filter((c) => c.kind === k).length}`).join('  '));

const topKTokens = sizes.slice(-TOP_K).reduce((a, b) => a + b, 0);
const medianTopK = pct(0.5) * TOP_K;

console.log(`\nskeleton (Strategy 4 always pays this)`);
console.log(`  tokens           ${skeleton.tokens.toLocaleString()}`);
console.log(`  vs corpus        ${((skeleton.tokens / corpusTokens) * 100).toFixed(1)}% of full repo`);
console.log(`  largest files    ` );
for (const f of [...skeleton.perFile].sort((a, b) => b.tokens - a.tokens).slice(0, 5)) {
  console.log(`    ${String(f.tokens).padStart(6)}  ${f.file}`);
}

console.log(`\nprojected context per query`);
console.log(`  full-stuff       ${Math.min(corpusTokens, CONTEXT_TOKEN_CAP).toLocaleString()}`);
console.log(`  top-${TOP_K}           ~${medianTopK.toLocaleString()} (median chunk x ${TOP_K})`);
console.log(`  skeleton+${TOP_K}      ~${(skeleton.tokens + medianTopK).toLocaleString()}`);
console.log(`  full-stuff is    ~${(Math.min(corpusTokens, CONTEXT_TOKEN_CAP) / medianTopK).toFixed(0)}x top-${TOP_K}`);
