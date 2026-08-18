import { NextResponse } from 'next/server';
import { embedQuery, fullStuff, topK, skeletonPlusChunks, retrieveRerank } from '@/lib/strategies';
import { llmRerank } from '@/lib/rerank';
import { generate } from '@/lib/llm';
import { buildPrompt, parseCitations } from '@/lib/prompt';
import { STRATEGIES, type StrategyId } from '@/config/models';

/**
 * Live mode: one strategy per request.
 *
 * A full sweep cannot happen inside a single serverless invocation -- full
 * stuffing alone has taken 33s, and four sequential strategies would blow any
 * function timeout. Splitting per strategy keeps each request comfortably
 * inside the limit, lets the browser fan out in parallel, gives honest
 * per-strategy latency, and degrades to three results instead of zero if one
 * strategy fails.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const VALID = new Set<StrategyId>(['full-stuff', 'top-k', 'rerank', 'skeleton']);

export async function POST(req: Request) {
  let body: { question?: unknown; strategy?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const strategy = body.strategy as StrategyId;

  if (!question) return NextResponse.json({ error: 'A question is required.' }, { status: 400 });
  if (question.length > 500) return NextResponse.json({ error: 'Question must be under 500 characters.' }, { status: 400 });
  if (!VALID.has(strategy)) return NextResponse.json({ error: `Unknown strategy: ${String(body.strategy)}` }, { status: 400 });

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'Live mode is unconfigured on this deployment (GEMINI_API_KEY is not set). Precomputed benchmark results are unaffected.' },
      { status: 503 },
    );
  }

  try {
    const started = Date.now();

    // Full stuffing ignores the question entirely, so it skips the embedding call.
    const ctx =
      strategy === 'full-stuff'
        ? fullStuff()
        : await (async () => {
            const qv = await embedQuery(question);
            if (strategy === 'top-k') return topK(qv);
            if (strategy === 'skeleton') return skeletonPlusChunks(qv);
            return retrieveRerank(question, qv, llmRerank);
          })();

    const res = await generate(buildPrompt(question, ctx.context));

    return NextResponse.json({
      strategy,
      label: STRATEGIES[strategy].label,
      answer: res.text,
      citedFiles: parseCitations(res.text),
      contextTokens: ctx.contextTokens,
      promptTokens: res.promptTokens,
      outputTokens: res.outputTokens,
      costUsd: res.costUsd,
      latencyMs: res.latencyMs,
      totalMs: Date.now() - started,
      cached: res.cached,
      filesInWindow: ctx.files.length,
      selected: ctx.selected.slice(0, 8).map((s) => ({ file: s.file, startLine: s.startLine, endLine: s.endLine, symbol: s.symbol })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    // Rate limits are the expected failure on a free tier; say so plainly
    // rather than surfacing a raw 429 body.
    const rateLimited = /429|quota|rate/i.test(message);
    return NextResponse.json(
      { error: rateLimited ? 'The free-tier rate limit was hit. Precomputed results below are unaffected.' : message },
      { status: rateLimited ? 429 : 500 },
    );
  }
}
