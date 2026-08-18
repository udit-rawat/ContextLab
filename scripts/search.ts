/**
 * Ad-hoc retrieval check: embed a question, cosine-rank the index, print hits.
 * Exists so retrieval quality can be eyeballed independently of the LLM layer.
 *
 *   npx tsx scripts/search.ts "how does FastAPI resolve dependencies?"
 */
import { readFileSync } from 'node:fs';
import { embedBatch, decodeVector, cosine } from '../lib/embed';
import { TOP_K } from '../config/models';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

interface IndexChunk { id: string; file: string; startLine: number; endLine: number; symbol: string | null; tokens: number; vector: string }

async function main() {
  const query = process.argv.slice(2).join(' ') || 'how does FastAPI resolve dependencies?';
  const index = JSON.parse(readFileSync('data/index.json', 'utf8')) as { chunks: IndexChunk[] };

  const [qv] = await embedBatch([query], 'RETRIEVAL_QUERY');
  const q = new Float32Array(qv);

  const ranked = index.chunks
    .map((c) => ({ c, score: cosine(q, decodeVector(c.vector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  console.log(`query: ${query}\n`);
  for (const { c, score } of ranked) {
    console.log(`  ${score.toFixed(3)}  ${c.file}:${c.startLine}-${c.endLine}  ${c.symbol ?? '(module)'}  [${c.tokens}t]`);
  }
  console.log(`\n  total context: ${ranked.reduce((n, r) => n + r.c.tokens, 0)} tokens`);
}
main().catch((e) => { console.error(e); process.exit(1); });
