import { encode, decode } from 'gpt-tokenizer';
import { embedBatch } from './embed';
import { search, loadSkeleton, allFilesInPathOrder, loadFullStuffPlan, type IndexChunk } from './store';
import {
  CONTEXT_TOKEN_CAP,
  OUTPUT_TOKEN_RESERVE,
  TOP_K,
  RERANK_POOL,
  RERANK_KEEP,
  type StrategyId,
} from '../config/models';

/**
 * The four context strategies, as pure context builders.
 *
 * None of these calls the answering model. Keeping context assembly separate
 * from generation means all four can be validated, diffed and token-counted
 * without spending a single request against the free-tier budget -- which
 * matters when the budget is ~250 requests a day.
 *
 * Strategy 3 is the exception: reranking genuinely requires a model call, so it
 * takes a reranker function as a parameter rather than reaching for one.
 */

export interface SelectedChunk {
  file: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  tokens: number;
  score: number;
}

export interface StrategyContext {
  strategy: StrategyId;
  context: string;
  /** Local estimate. The authoritative count comes from the API's usageMetadata. */
  contextTokens: number;
  selected: SelectedChunk[];
  /** Distinct files represented in the context. Denominator for citation scoring. */
  files: string[];
  /** Extra model calls this strategy needed beyond the answer itself. */
  extraCalls: number;
  meta: Record<string, unknown>;
}

/** Budget available for context after reserving room for the answer. */
export const CONTEXT_BUDGET = CONTEXT_TOKEN_CAP - OUTPUT_TOKEN_RESERVE;

const countTokens = (s: string): number => encode(s).length;

const renderChunk = (c: IndexChunk): string =>
  `# ${c.file}:${c.startLine}-${c.endLine}${c.symbol ? ` (${c.symbol})` : ''}\n${c.text}`;

const toSelected = (c: IndexChunk, score: number): SelectedChunk => ({
  file: c.file,
  startLine: c.startLine,
  endLine: c.endLine,
  symbol: c.symbol,
  tokens: c.tokens,
  score,
});

const distinctFiles = (sel: SelectedChunk[]): string[] => [...new Set(sel.map((s) => s.file))].sort();

export async function embedQuery(question: string): Promise<Float32Array> {
  const [v] = await embedBatch([question], 'RETRIEVAL_QUERY');
  return new Float32Array(v);
}

/**
 * Strategy 1: full stuffing.
 *
 * Concatenate whole files in path order until the budget is gone, then stop.
 * Deliberately naive -- no relevance ordering -- because that is the baseline
 * being characterised. Which files fall off the end is recorded, since on this
 * corpus two files are 55% of the tokens and what gets dropped is the finding.
 */
export function fullStuff(root = process.cwd()): StrategyContext {
  const plan = loadFullStuffPlan(root);
  const byFile = new Map(allFilesInPathOrder(root).map((f) => [f.file, `# ${f.file}\n${f.text}`]));

  const parts: string[] = [];
  const selected: SelectedChunk[] = [];

  for (const file of plan.wholeFiles) {
    const text = byFile.get(file);
    if (text === undefined) throw new Error(`fullstuff plan references missing file: ${file}`);
    parts.push(text);
    selected.push({ file, startLine: 1, endLine: -1, symbol: null, tokens: countTokens(text), score: 0 });
  }

  if (plan.partial) {
    const text = byFile.get(plan.partial.file);
    if (text === undefined) throw new Error(`fullstuff plan references missing file: ${plan.partial.file}`);
    const kept = text.slice(0, plan.partial.chars);
    parts.push(kept);
    selected.push({ file: plan.partial.file, startLine: 1, endLine: -1, symbol: null, tokens: countTokens(kept), score: 0 });
  }

  const included = [...plan.wholeFiles, ...(plan.partial ? [plan.partial.file] : [])];

  return {
    strategy: 'full-stuff',
    context: parts.join('\n\n'),
    // Gemini's own count, measured at build time. Every other strategy reports
    // a gpt-tokenizer estimate here; only this one has the cap actually biting,
    // so only this one needs the exact figure.
    contextTokens: plan.geminiTokens,
    selected,
    files: included,
    extraCalls: 0,
    meta: {
      filesFullyIncluded: plan.wholeFiles.length,
      filesPartiallyIncluded: plan.partial ? 1 : 0,
      filesOmitted: plan.omittedFiles.length,
      partialFile: plan.partial,
      omittedFiles: plan.omittedFiles,
      corpusTokens: plan.corpusGeminiTokens,
      droppedTokenShare: plan.droppedTokenShare,
      tokenizerRatio: plan.tokenizerRatio,
      tokensAreExact: true,
    },
  };
}

/** Strategy 2: top-k vector retrieval. The fair baseline. */
export function topK(queryVector: Float32Array, k = TOP_K, root = process.cwd()): StrategyContext {
  const hits = search(queryVector, k, root);
  const selected = hits.map((h) => toSelected(h.chunk, h.score));
  const context = hits.map((h) => renderChunk(h.chunk)).join('\n\n');
  return {
    strategy: 'top-k',
    context,
    contextTokens: countTokens(context),
    selected,
    files: distinctFiles(selected),
    extraCalls: 0,
    meta: { k },
  };
}

export type Reranker = (question: string, candidates: IndexChunk[], keep: number) => Promise<number[]>;

/** Strategy 3: retrieve wide, rerank narrow. Costs one extra model call. */
export async function retrieveRerank(
  question: string,
  queryVector: Float32Array,
  rerank: Reranker,
  root = process.cwd(),
): Promise<StrategyContext> {
  const pool = search(queryVector, RERANK_POOL, root);
  const order = await rerank(question, pool.map((p) => p.chunk), RERANK_KEEP);
  const kept = order
    .filter((i) => i >= 0 && i < pool.length)
    .slice(0, RERANK_KEEP)
    .map((i) => pool[i]);
  // If the reranker returns nothing usable, fall back to vector order rather
  // than emitting an empty context, and record that it happened.
  const finalHits = kept.length ? kept : pool.slice(0, RERANK_KEEP);

  const selected = finalHits.map((h) => toSelected(h.chunk, h.score));
  const context = finalHits.map((h) => renderChunk(h.chunk)).join('\n\n');
  return {
    strategy: 'rerank',
    context,
    contextTokens: countTokens(context),
    selected,
    files: distinctFiles(selected),
    extraCalls: 1,
    meta: { pool: RERANK_POOL, keep: RERANK_KEEP, rerankerFellBack: kept.length === 0 },
  };
}

/**
 * Strategy 4: structure-aware compression.
 *
 * Always pay for the repo skeleton, then add full bodies only for retrieved
 * chunks. The closest analogue to what a context engine claims to do, which is
 * why it belongs in the comparison rather than being assumed to win.
 */
export function skeletonPlusChunks(queryVector: Float32Array, k = TOP_K, root = process.cwd()): StrategyContext {
  const skeleton = loadSkeleton(root);
  const hits = search(queryVector, k, root);
  const selected = hits.map((h) => toSelected(h.chunk, h.score));

  const header = '# Repository skeleton (signatures and docstrings, no bodies)\n';
  const bodies = '\n\n# Full source for the most relevant chunks\n\n' + hits.map((h) => renderChunk(h.chunk)).join('\n\n');
  const context = header + skeleton.text + bodies;

  return {
    strategy: 'skeleton',
    context,
    contextTokens: countTokens(context),
    selected,
    files: distinctFiles(selected),
    extraCalls: 0,
    meta: { skeletonTokens: skeleton.tokens, k },
  };
}
