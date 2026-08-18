/**
 * Builds all four contexts for one question and reports what each selected.
 * Uses a single embedding call and no answer calls, so strategy assembly can
 * be validated without spending the answerer's daily budget.
 *
 *   npx tsx scripts/try-strategies.ts "how does FastAPI resolve dependencies?"
 */
import { readFileSync } from 'node:fs';
import { embedQuery, fullStuff, topK, skeletonPlusChunks, retrieveRerank, CONTEXT_BUDGET } from '../lib/strategies';
import { CONTEXT_TOKEN_CAP, STRATEGIES } from '../config/models';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const question = process.argv.slice(2).join(' ') || 'How does FastAPI resolve and inject dependencies for a route?';
  console.log(`question: ${question}`);
  console.log(`budget:   ${CONTEXT_BUDGET.toLocaleString()} tokens (cap ${CONTEXT_TOKEN_CAP.toLocaleString()} minus output reserve)\n`);

  const qv = await embedQuery(question);

  // Stub reranker: identity order. The real one costs a model call and is
  // exercised separately, so this stays free.
  const stubRerank = async (_q: string, c: unknown[], keep: number) => [...Array(Math.min(keep, c.length)).keys()];

  const results = [
    fullStuff(),
    topK(qv),
    await retrieveRerank(question, qv, stubRerank),
    skeletonPlusChunks(qv),
  ];

  const base = results.find((r) => r.strategy === 'top-k')!;

  for (const r of results) {
    const label = STRATEGIES[r.strategy].label;
    const vsBase = r.contextTokens / base.contextTokens;
    console.log(`${label}  [${r.strategy}]`);
    console.log(`  context tokens  ${r.contextTokens.toLocaleString()}  (${vsBase.toFixed(1)}x baseline)`);
    console.log(`  within budget   ${r.contextTokens <= CONTEXT_BUDGET ? 'yes' : 'NO - OVER'}`);
    console.log(`  files in window ${r.files.length}`);
    console.log(`  extra calls     ${r.extraCalls}`);
    if (r.strategy === 'full-stuff') {
      const m = r.meta as { filesFullyIncluded: number; filesPartiallyIncluded: number; filesOmitted: number; droppedTokenShare: number; omittedFiles: string[]; partialFile: { file: string; chars: number; tokens: number } | null; tokensAreExact?: boolean };
      console.log(`  files whole     ${m.filesFullyIncluded}`);
      console.log(`  file truncated  ${m.partialFile ? `${m.partialFile.file} (first ${m.partialFile.chars.toLocaleString()} chars)` : '(none)'}`);
      console.log(`  token counts    ${m.tokensAreExact ? 'exact (gemini countTokens)' : 'estimated'}`);
      console.log(`  files omitted   ${m.filesOmitted}: ${m.omittedFiles.map((f) => f.replace('fastapi/', '')).join(', ') || '(none)'}`);
      console.log(`  tokens dropped  ${(m.droppedTokenShare * 100).toFixed(1)}%`);
    } else {
      console.log(`  top selections  ${r.selected.slice(0, 4).map((s) => `${s.file.replace('fastapi/', '')}:${s.startLine}`).join('  ')}`);
    }
    console.log();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
