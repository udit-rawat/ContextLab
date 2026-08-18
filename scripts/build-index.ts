/**
 * Builds the committed retrieval index: chunks the corpus, embeds every chunk,
 * and writes data/index.json plus data/skeleton.json.
 *
 * Both artifacts are committed. At ~750 chunks a flat file plus cosine
 * similarity in JS is faster than a vector database round trip, adds no
 * runtime dependency, and is readable by a reviewer. A vector DB earns its
 * place at millions of chunks, not hundreds.
 *
 * Embeddings are cached on disk by content hash, so a rerun after a chunker
 * change only re-embeds what actually changed. That matters: the free tier
 * allows few enough requests per day that a naive full re-embed would be a
 * meaningful fraction of the daily budget.
 *
 *   npx tsx scripts/build-index.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chunkPythonFile, chunkHeader, type Chunk } from '../lib/chunker';
import { buildSkeleton } from '../lib/skeleton';
import { embedBatch, encodeVector } from '../lib/embed';
import { EMBED_MODEL, EMBED_DIMENSIONS, CORPUS } from '../config/models';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const CORPUS_DIR = join(process.cwd(), 'corpus');
  const CACHE_DIR = join(process.cwd(), '.cache');
  // Sized against the free-tier per-minute embedding limit. 100 at once returns
// 429 immediately; 25 with a pause between batches runs clean.
const BATCH_SIZE = 25;
const BATCH_PAUSE_MS = 6_000;

  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.py')) out.push(p);
    }
    return out;
  };

  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

  const files = walk(CORPUS_DIR)
    .sort()
    .map((abs) => ({ file: relative(CORPUS_DIR, abs), source: readFileSync(abs, 'utf8') }));

  const chunks: Chunk[] = files.flatMap((f) => chunkPythonFile(f.file, f.source));
  console.log(`${files.length} files -> ${chunks.length} chunks`);

  // Resume cache: content hash -> base64 vector.
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `embeddings-${EMBED_MODEL}-${EMBED_DIMENSIONS}.json`);
  const cache: Record<string, string> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

  const texts = chunks.map((c) => chunkHeader(c));
  const hashes = texts.map(hash);
  const todo = [...new Set(hashes.filter((h) => !cache[h]))];
  console.log(`${hashes.length - todo.length} cached, ${todo.length} to embed`);

  const byHash = new Map<string, string>();
  for (let i = 0; i < hashes.length; i++) if (!byHash.has(hashes[i])) byHash.set(hashes[i], texts[i]);

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const t0 = Date.now();
    const vectors = await embedBatch(batch.map((h) => byHash.get(h)!), 'RETRIEVAL_DOCUMENT');
    batch.forEach((h, j) => { cache[h] = encodeVector(vectors[j]); });
    writeFileSync(cachePath, JSON.stringify(cache));
    console.log(`  embedded ${Math.min(i + BATCH_SIZE, todo.length)}/${todo.length} (${Date.now() - t0}ms)`);
    if (i + BATCH_SIZE < todo.length) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
  }

  const skeleton = buildSkeleton(files);

  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(
    join(process.cwd(), 'data', 'index.json'),
    JSON.stringify({
      model: EMBED_MODEL,
      dimensions: EMBED_DIMENSIONS,
      corpus: { commit: CORPUS.commit, files: files.length },
      encoding: 'base64 little-endian float32',
      chunks: chunks.map((c, i) => ({
        id: c.id, file: c.file, startLine: c.startLine, endLine: c.endLine,
        symbol: c.symbol, kind: c.kind, tokens: c.tokens, text: c.text,
        vector: cache[hashes[i]],
      })),
    }),
  );

  writeFileSync(
    join(process.cwd(), 'data', 'skeleton.json'),
    JSON.stringify({ corpus: { commit: CORPUS.commit }, tokens: skeleton.tokens, text: skeleton.text, perFile: skeleton.perFile.map((f) => ({ file: f.file, tokens: f.tokens })) }),
  );

  const sizeMb = (p: string) => (readFileSync(p).length / 1e6).toFixed(2);
  console.log(`\nwrote data/index.json     ${sizeMb('data/index.json')} MB  (${chunks.length} chunks)`);
  console.log(`wrote data/skeleton.json  ${sizeMb('data/skeleton.json')} MB  (${skeleton.tokens.toLocaleString()} tokens)`);

}

main().catch((e) => { console.error(e); process.exit(1); });
