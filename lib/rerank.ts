import { generate } from './llm';
import { buildRerankPrompt, parseRerankOrder } from './prompt';
import type { IndexChunk } from './store';

/**
 * LLM reranker for Strategy 3.
 *
 * Uses the answering model rather than a dedicated rerank API. A hosted
 * reranker would likely be better, but adding a fourth vendor for the strategy
 * that is first on the cut list is a poor trade, and this way the extra cost
 * Strategy 3 pays is measured in the same units as everything else.
 */
export async function llmRerank(question: string, candidates: IndexChunk[], keep: number): Promise<number[]> {
  const prompt = buildRerankPrompt(question, candidates, keep);
  const res = await generate(prompt, { maxOutputTokens: 256 });
  return parseRerankOrder(res.text).filter((i) => i >= 0 && i < candidates.length);
}
