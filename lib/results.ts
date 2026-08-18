import type { StrategyId } from '../config/models';

/**
 * The benchmark results contract.
 *
 * Defined before the eval harness runs so the UI and the harness agree on a
 * shape, and so quality scores can be null while the rest of the numbers are
 * already real. Everything the site displays comes from a committed file in
 * this shape -- the deployed page never calls a model to render results.
 */

export type QuestionType = 'factual' | 'cross-file' | 'architectural';

export interface ResultRow {
  questionId: string;
  question: string;
  type: QuestionType;
  strategy: StrategyId;
  /** Context tokens as assembled locally. */
  contextTokens: number;
  /** Prompt tokens as billed, from the API. Authoritative. */
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  answer: string;
  citedFiles: string[];
  expectedFiles: string[];
  /** Of the files cited, the share that were expected. Null if nothing cited. */
  citationPrecision: number | null;
  /** Of the files expected, the share that were cited. */
  citationRecall: number | null;
  /** Judge rubric score, 0-5. Null until the eval harness has run. */
  qualityScore: number | null;
  judgeRationale: string | null;
  filesInWindow: string[];
}

export interface Benchmark {
  generatedAt: string;
  answerModel: string;
  judgeModel: string;
  embedModel: string;
  corpusCommit: string;
  corpusTokens: number;
  contextTokenCap: number;
  rows: ResultRow[];
}

export interface StrategyAggregate {
  strategy: StrategyId;
  n: number;
  meanQuality: number | null;
  sdQuality: number | null;
  meanCitationPrecision: number | null;
  meanCitationRecall: number | null;
  meanCostUsd: number;
  meanContextTokens: number;
  meanPromptTokens: number;
  meanLatencyMs: number;
  /** Questions where the answer cited no file at all. */
  uncited: number;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Sample standard deviation. */
const sd = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

const defined = <T>(xs: (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

export function aggregate(rows: ResultRow[], strategy: StrategyId): StrategyAggregate {
  const r = rows.filter((x) => x.strategy === strategy);
  const quality = defined(r.map((x) => x.qualityScore));
  const precision = defined(r.map((x) => x.citationPrecision));
  const recall = defined(r.map((x) => x.citationRecall));

  return {
    strategy,
    n: r.length,
    meanQuality: quality.length ? mean(quality) : null,
    sdQuality: quality.length ? sd(quality) : null,
    meanCitationPrecision: precision.length ? mean(precision) : null,
    meanCitationRecall: recall.length ? mean(recall) : null,
    meanCostUsd: mean(r.map((x) => x.costUsd)),
    meanContextTokens: mean(r.map((x) => x.contextTokens)),
    meanPromptTokens: mean(r.map((x) => x.promptTokens)),
    meanLatencyMs: mean(r.map((x) => x.latencyMs)),
    uncited: r.filter((x) => x.citedFiles.length === 0).length,
  };
}

/**
 * Whether a difference between two strategies is large enough to claim.
 *
 * The rule, stated once and applied everywhere: a gap between two strategies
 * counts only if it exceeds the within-strategy question-to-question spread.
 * Question difficulty varies far more than strategy does on a corpus this size,
 * so a mean difference smaller than that noise is a tie, and gets called a tie
 * rather than being reported as an improvement.
 *
 * Pooled SD is used rather than either strategy's alone so the threshold does
 * not depend on which one is named first.
 */
export function isTie(a: StrategyAggregate, b: StrategyAggregate): boolean | null {
  if (a.meanQuality === null || b.meanQuality === null) return null;
  if (a.sdQuality === null || b.sdQuality === null) return null;
  const pooled = Math.sqrt((a.sdQuality ** 2 + b.sdQuality ** 2) / 2);
  return Math.abs(a.meanQuality - b.meanQuality) < pooled;
}

/**
 * Strategies not dominated on both axes: nothing else is simultaneously
 * cheaper and at least as good. This is what makes the scatter readable at a
 * glance -- the frontier is the answer to "which of these should I use".
 */
export function paretoFrontier(
  aggs: StrategyAggregate[],
  yOf: (a: StrategyAggregate) => number | null = (a) => a.meanQuality,
): StrategyId[] {
  const scored = aggs.filter((a) => yOf(a) !== null);
  return scored
    .filter(
      (a) =>
        !scored.some((b) => {
          if (b === a) return false;
          const ya = yOf(a)!;
          const yb = yOf(b)!;
          return b.meanCostUsd <= a.meanCostUsd && yb >= ya && (b.meanCostUsd < a.meanCostUsd || yb > ya);
        }),
    )
    .map((a) => a.strategy);
}

/** True once the eval harness has populated quality scores. */
export function hasQualityScores(b: Benchmark): boolean {
  return b.rows.some((r) => r.qualityScore !== null);
}
