/**
 * Single source of truth for every pinned value the benchmark depends on.
 *
 * Deliberately committed (not in .env) so a reviewer can verify how each
 * reported number was derived without holding any API key. .env holds
 * secrets only. If a number in the writeup cannot be traced back to this
 * file plus results/benchmark.json, it is a bug.
 */

/** Model used to answer questions under ALL four strategies. */
export const ANSWER_MODEL = 'gemini-3.1-flash-lite';

/**
 * Why flash-lite and not a stronger model:
 *  1. It emits zero thinking tokens (measured, asserted in scripts/smoke.mjs).
 *     Thinking tokens are billed and vary run to run, which would make
 *     cost-per-query non-reproducible.
 *  2. gemini-2.5-flash is closed to new accounts; gemini-3.6-flash returned
 *     503 under load and burned 205 thinking tokens on a 1-token prompt.
 *  3. A lighter model is more sensitive to context quality, so the four
 *     strategies separate instead of collapsing into noise.
 */

/** Embeddings. 768d via MRL truncation: 3072d would make the index ~47MB. */
export const EMBED_MODEL = 'gemini-embedding-001';
export const EMBED_DIMENSIONS = 768;

/** LLM-as-judge. Different family from ANSWER_MODEL so the judge cannot
 *  exhibit self-preference toward its own generations. */
export const JUDGE_MODEL = 'openai/gpt-oss-120b';

/**
 * Published list prices, USD per 1M tokens.
 * Verified 2026-08-18:
 *   Gemini — https://ai.google.dev/gemini-api/docs/pricing
 *   Groq   — https://console.groq.com/docs/models
 *
 * The benchmark itself runs on free tier, so actual spend was $0.00.
 * Reported costs are these list prices applied to measured token counts,
 * which is what the numbers would cost in production.
 */
export const PRICING = {
  [ANSWER_MODEL]: { inputPerM: 0.25, outputPerM: 1.5 },
  [EMBED_MODEL]: { inputPerM: 0.15, outputPerM: 0 },
  [JUDGE_MODEL]: { inputPerM: 0.15, outputPerM: 0.6 },
} as const;

/**
 * Context budget applied to EVERY strategy, including full stuffing.
 *
 * Gemini's real window is 1,048,576 tokens, which would swallow the entire
 * corpus and make "full stuffing" never truncate. Capping at 128k models the
 * window most deployed models actually offer, so the comparison measures
 * retrieval strategy rather than one vendor's context length. Stated here,
 * applied everywhere, no exceptions.
 */
export const CONTEXT_TOKEN_CAP = 128_000;

/** Tokens reserved for the prompt scaffold and the model's answer. */
export const OUTPUT_TOKEN_RESERVE = 2_000;

/** Retrieval parameters. */
export const TOP_K = 8;
export const RERANK_POOL = 30;
export const RERANK_KEEP = 8;

/** Chunking. */
export const MAX_CHUNK_TOKENS = 400;
export const CHUNK_OVERLAP_TOKENS = 40;

/**
 * Corpus: FastAPI source only, pinned by commit so results reproduce even
 * after upstream ships a release. Tests excluded (~1.1M tokens, out of the
 * 100k-400k target band); docs excluded (33MB, mostly translations).
 */
export const CORPUS = {
  repo: 'https://github.com/fastapi/fastapi.git',
  commit: '66b2c5a9b5ddf65f218423072ad158e42ed780aa',
  include: 'fastapi/**/*.py',
  localDir: 'corpus/fastapi',
} as const;

export type StrategyId = 'full-stuff' | 'top-k' | 'rerank' | 'skeleton';

/** Strategy 2 is the fair baseline: what a competent engineer builds by
 *  default. All improvements are reported against it, never against
 *  full-stuffing, which exists only to establish the cost ceiling. */
export const BASELINE_STRATEGY: StrategyId = 'top-k';

export const STRATEGIES: Record<StrategyId, { label: string; blurb: string }> = {
  'full-stuff': {
    label: 'Full stuffing',
    blurb: `Concatenate the whole repo until the ${CONTEXT_TOKEN_CAP.toLocaleString()}-token cap, truncate the rest.`,
  },
  'top-k': {
    label: `Top-${TOP_K} vector`,
    blurb: `Embed chunks, cosine similarity, take top ${TOP_K}. The fair baseline.`,
  },
  rerank: {
    label: 'Retrieve + rerank',
    blurb: `Retrieve ${RERANK_POOL} candidates, rerank down to ${RERANK_KEEP}. One extra model call.`,
  },
  skeleton: {
    label: 'Structure-aware',
    blurb: 'Always include the repo skeleton (tree + signatures + docstrings), then full bodies only for retrieved chunks.',
  },
};

/** Cost in USD for one call, from measured token counts. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model as keyof typeof PRICING];
  if (!p) throw new Error(`No pricing recorded for model: ${model}`);
  return (inputTokens / 1e6) * p.inputPerM + (outputTokens / 1e6) * p.outputPerM;
}
