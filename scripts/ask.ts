/**
 * Runs one question through all four strategies with real model calls and
 * prints measured tokens, cost, latency and citations.
 *
 * Costs 5 requests (4 answers + 1 rerank), cached thereafter.
 *
 *   npx tsx scripts/ask.ts "how does FastAPI resolve dependencies?"
 */
import { readFileSync } from 'node:fs';
import { embedQuery, fullStuff, topK, skeletonPlusChunks, retrieveRerank, type StrategyContext } from '../lib/strategies';
import { llmRerank } from '../lib/rerank';
import { generate } from '../lib/llm';
import { buildPrompt, parseCitations } from '../lib/prompt';
import { STRATEGIES } from '../config/models';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const question = process.argv.slice(2).join(' ') || 'How does FastAPI resolve and inject dependencies for a route?';
  console.log(`question: ${question}\n`);

  const qv = await embedQuery(question);
  const contexts: StrategyContext[] = [
    fullStuff(),
    topK(qv),
    await retrieveRerank(question, qv, llmRerank),
    skeletonPlusChunks(qv),
  ];

  const rows: { label: string; ctx: StrategyContext; promptTokens: number; outputTokens: number; thoughts: number; cost: number; ms: number; cached: boolean; cites: string[]; text: string }[] = [];

  for (const ctx of contexts) {
    const res = await generate(buildPrompt(question, ctx.context));
    rows.push({
      label: STRATEGIES[ctx.strategy].label,
      ctx,
      promptTokens: res.promptTokens,
      outputTokens: res.outputTokens,
      thoughts: res.thoughtTokens,
      cost: res.costUsd,
      ms: res.latencyMs,
      cached: res.cached,
      cites: parseCitations(res.text),
      text: res.text,
    });
  }

  const pad = (s: unknown, n: number) => String(s).padEnd(n);
  console.log(`${pad('strategy', 18)} ${pad('est tok', 9)} ${pad('actual', 9)} ${pad('out', 6)} ${pad('thoughts', 9)} ${pad('cost', 10)} ${pad('latency', 9)} cached`);
  for (const r of rows) {
    console.log(
      `${pad(r.label, 18)} ${pad(r.ctx.contextTokens.toLocaleString(), 9)} ${pad(r.promptTokens.toLocaleString(), 9)} ${pad(r.outputTokens, 6)} ${pad(r.thoughts, 9)} ${pad('$' + r.cost.toFixed(6), 10)} ${pad(r.ms + 'ms', 9)} ${r.cached}`,
    );
  }

  const base = rows.find((r) => r.ctx.strategy === 'top-k')!;
  console.log(`\ncost vs top-k baseline:`);
  for (const r of rows) console.log(`  ${pad(r.label, 18)} ${(r.cost / base.cost).toFixed(1)}x`);

  console.log(`\nanswers:`);
  for (const r of rows) {
    console.log(`\n--- ${r.label} ---`);
    console.log(r.text.trim().slice(0, 500));
    console.log(`  cited: ${r.cites.join(', ') || '(none parsed)'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
