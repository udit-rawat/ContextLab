/**
 * Runs every question against every strategy and writes results/benchmark.json.
 *
 * This is the file the deployed site reads. The site never calls a model to
 * render results -- a Vercel function cannot run a multi-strategy sweep inside
 * one request, and a deployed page that depends on a live API key is one rate
 * limit away from showing nothing to a reviewer.
 *
 *   npx tsx scripts/run-benchmark.ts [--questions eval/questions.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { embedQuery, fullStuff, topK, skeletonPlusChunks, retrieveRerank, type StrategyContext } from '../lib/strategies';
import { llmRerank } from '../lib/rerank';
import { generate } from '../lib/llm';
import { buildPrompt, parseCitations } from '../lib/prompt';
import { loadFullStuffPlan } from '../lib/store';
import { scoreAnswer } from '../lib/judge';
import type { Benchmark, ResultRow, QuestionType } from '../lib/results';
import { ANSWER_MODEL, JUDGE_MODEL, EMBED_MODEL, CORPUS, CONTEXT_TOKEN_CAP } from '../config/models';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

interface Question {
  id: string;
  type: QuestionType;
  question: string;
  expectedFiles: string[];
  /** Reference answer the judge grades against. */
  expectedAnswer?: string;
  /** file:line pointers so a human can verify the reference. Not sent to any model. */
  verify?: string;
}

/** Precision and recall over cited files. Reported separately from the quality
 *  rubric on purpose: one metric is a single point of failure, and where the two
 *  disagree that disagreement is itself a result. */
function citationScores(cited: string[], expected: string[]): { precision: number | null; recall: number | null } {
  const norm = (f: string) => f.trim().replace(/^\.\//, '');
  const c = new Set(cited.map(norm));
  const e = new Set(expected.map(norm));
  if (c.size === 0) return { precision: null, recall: 0 };
  const hits = [...c].filter((f) => e.has(f)).length;
  return { precision: hits / c.size, recall: e.size ? [...e].filter((f) => c.has(f)).length / e.size : null };
}

async function main() {
  const argIdx = process.argv.indexOf('--questions');
  const questionsPath = argIdx !== -1 ? process.argv[argIdx + 1] : 'eval/questions.json';
  const questions = JSON.parse(readFileSync(questionsPath, 'utf8')) as Question[];
  console.log(`${questions.length} questions x 4 strategies = ${questions.length * 4} answer calls\n`);

  const rows: ResultRow[] = [];
  let newCalls = 0;

  for (const q of questions) {
    process.stdout.write(`${q.id}  ${q.question.slice(0, 58)}\n`);
    const qv = await embedQuery(q.question);

    const contexts: StrategyContext[] = [
      fullStuff(),
      topK(qv),
      await retrieveRerank(q.question, qv, llmRerank),
      skeletonPlusChunks(qv),
    ];

    for (const ctx of contexts) {
      const res = await generate(buildPrompt(q.question, ctx.context));
      if (!res.cached) newCalls++;
      const cited = parseCitations(res.text);
      const { precision, recall } = citationScores(cited, q.expectedFiles);

      // Judged blind: the judge sees question, reference and candidate only.
      // It is never told which strategy produced the answer.
      const verdict = q.expectedAnswer
        ? await scoreAnswer(q.question, q.expectedAnswer, res.text)
        : { score: null, rationale: null };

      rows.push({
        questionId: q.id,
        question: q.question,
        type: q.type,
        strategy: ctx.strategy,
        contextTokens: ctx.contextTokens,
        promptTokens: res.promptTokens,
        outputTokens: res.outputTokens,
        costUsd: res.costUsd,
        latencyMs: res.latencyMs,
        answer: res.text,
        citedFiles: cited,
        expectedFiles: q.expectedFiles,
        citationPrecision: precision,
        citationRecall: recall,
        qualityScore: verdict.score,
        judgeRationale: verdict.rationale,
        filesInWindow: ctx.files,
      });

      process.stdout.write(
        `    ${ctx.strategy.padEnd(12)} ${String(res.promptTokens).padStart(7)}t  $${res.costUsd.toFixed(6)}  ${String(res.latencyMs).padStart(6)}ms  prec=${precision === null ? '-' : precision.toFixed(2)}  score=${verdict.score ?? '-'}  ${res.cached ? '(cached)' : ''}\n`,
      );
    }
  }

  const plan = loadFullStuffPlan();
  const benchmark: Benchmark = {
    generatedAt: new Date().toISOString(),
    answerModel: ANSWER_MODEL,
    judgeModel: JUDGE_MODEL,
    embedModel: EMBED_MODEL,
    corpusCommit: CORPUS.commit,
    corpusTokens: plan.corpusGeminiTokens,
    contextTokenCap: CONTEXT_TOKEN_CAP,
    rows,
  };

  mkdirSync(join(process.cwd(), 'results'), { recursive: true });
  writeFileSync(join(process.cwd(), 'results', 'benchmark.json'), JSON.stringify(benchmark, null, 2) + '\n');
  console.log(`\nwrote results/benchmark.json  (${rows.length} rows, ${newCalls} new model calls)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
