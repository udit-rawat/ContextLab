import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeVector, cosine } from './embed';

/**
 * Loads the committed index and answers cosine queries against it.
 *
 * A flat file scanned in JS beats a vector database at this corpus size: 744
 * chunks x 768 dimensions is ~2.3M multiply-adds per query, which runs in
 * single-digit milliseconds -- faster than the network round trip to a hosted
 * vector store, with no service to provision and an index a reviewer can read.
 */

export interface IndexChunk {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  kind: 'function' | 'class' | 'module';
  tokens: number;
  text: string;
  vector: string;
}

export interface Scored {
  chunk: IndexChunk;
  score: number;
}

let cachedIndex: { chunks: IndexChunk[]; vectors: Float32Array[] } | null = null;
let cachedSkeleton: { text: string; tokens: number } | null = null;

export function loadIndex(root = process.cwd()) {
  if (!cachedIndex) {
    const raw = JSON.parse(readFileSync(join(root, 'data', 'index.json'), 'utf8')) as { chunks: IndexChunk[] };
    cachedIndex = { chunks: raw.chunks, vectors: raw.chunks.map((c) => decodeVector(c.vector)) };
  }
  return cachedIndex;
}

export function loadSkeleton(root = process.cwd()) {
  if (!cachedSkeleton) {
    const raw = JSON.parse(readFileSync(join(root, 'data', 'skeleton.json'), 'utf8')) as { text: string; tokens: number };
    cachedSkeleton = { text: raw.text, tokens: raw.tokens };
  }
  return cachedSkeleton;
}

/** Rank every chunk against a query vector. */
export function search(queryVector: Float32Array, k: number, root = process.cwd()): Scored[] {
  const { chunks, vectors } = loadIndex(root);
  return chunks
    .map((chunk, i) => ({ chunk, score: cosine(queryVector, vectors[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Whole files reassembled from the index, in path order. Used by full stuffing,
 *  which concatenates source rather than retrieved chunks. */
export function allFilesInPathOrder(root = process.cwd()): { file: string; text: string; tokens: number }[] {
  const { chunks } = loadIndex(root);
  const byFile = new Map<string, IndexChunk[]>();
  for (const c of chunks) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, cs]) => {
      const ordered = [...cs].sort((a, b) => a.startLine - b.startLine);
      return {
        file,
        text: ordered.map((c) => c.text).join('\n'),
        tokens: ordered.reduce((n, c) => n + c.tokens, 0),
      };
    });
}

export interface FullStuffPlan {
  budgetTokens: number;
  geminiTokens: number;
  corpusGeminiTokens: number;
  tokenizerRatio: number;
  wholeFiles: string[];
  partial: { file: string; chars: number; tokens: number } | null;
  omittedFiles: string[];
  droppedTokenShare: number;
}

let cachedPlan: FullStuffPlan | null = null;

/** The precomputed full-stuffing cut, exact in Gemini tokens. Built by
 *  scripts/build-fullstuff.ts; committed so it needs no API key to reproduce. */
export function loadFullStuffPlan(root = process.cwd()): FullStuffPlan {
  if (!cachedPlan) {
    cachedPlan = JSON.parse(readFileSync(join(root, 'data', 'fullstuff.json'), 'utf8')) as FullStuffPlan;
  }
  return cachedPlan;
}
