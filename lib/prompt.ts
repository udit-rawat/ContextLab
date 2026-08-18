/**
 * One prompt template, shared by all four strategies.
 *
 * Only the context block differs between strategies. If the instructions or
 * the answer format varied too, the benchmark would be measuring prompt
 * engineering rather than context selection, and no difference in the results
 * could be attributed to retrieval.
 */

export const SYSTEM_INSTRUCTION = `You are a precise code analyst answering questions about a Python repository (FastAPI).

Rules:
- Answer only from the provided context. If the context does not contain the answer, say so explicitly.
- Cite the files you relied on. End your response with a line formatted exactly as:
  FILES: path/one.py, path/two.py
- Keep the answer under 200 words. Be specific: name functions, classes and modules.`;

export function buildPrompt(question: string, context: string): string {
  return `${SYSTEM_INSTRUCTION}

--- BEGIN REPOSITORY CONTEXT ---
${context}
--- END REPOSITORY CONTEXT ---

Question: ${question}

Answer:`;
}

/** Pull the FILES: line out of a response. Citation precision is scored on this. */
export function parseCitations(answer: string): string[] {
  const matches = [...answer.matchAll(/^\s*FILES:\s*(.+)$/gim)];
  if (!matches.length) return [];
  return [
    ...new Set(
      matches[matches.length - 1][1]
        .split(',')
        .map((s) => s.trim().replace(/^`|`$/g, ''))
        .filter(Boolean),
    ),
  ];
}

/** Rerank prompt: ask the model to order candidates, not to answer. */
export function buildRerankPrompt(question: string, candidates: { file: string; startLine: number; endLine: number; symbol: string | null; text: string }[], keep: number): string {
  const listed = candidates
    .map((c, i) => `[${i}] ${c.file}:${c.startLine}-${c.endLine}${c.symbol ? ` (${c.symbol})` : ''}\n${c.text.slice(0, 600)}`)
    .join('\n\n');

  return `You are ranking code snippets by how useful they are for answering a question about the FastAPI repository.

Question: ${question}

Candidates:
${listed}

Return the ${keep} most useful candidate indices, most useful first, as a comma-separated list of numbers and nothing else. Example: 3,0,7,1,5,2,9,4`;
}

export function parseRerankOrder(text: string): number[] {
  const nums = text.match(/\d+/g);
  return nums ? [...new Set(nums.map(Number))] : [];
}
