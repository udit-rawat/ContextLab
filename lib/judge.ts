import { judge as callJudge } from './llm';

/**
 * LLM-as-judge scoring against a written-down rubric.
 *
 * Two properties matter more than the prompt wording:
 *
 * 1. The judge runs on a different model family from the answerer (Groq's
 *    gpt-oss-120b vs Gemini), so it cannot systematically prefer its own
 *    generations. Self-preference is a real effect and a same-family judge
 *    would quietly inflate whichever strategy the answerer favours.
 * 2. The judge never sees which strategy produced an answer. It gets the
 *    question, a reference answer and one candidate. There is no channel
 *    through which strategy identity could bias the score.
 *
 * The rubric is stated here in full rather than described, so a reviewer can
 * read the exact instrument that produced the numbers.
 */

export const RUBRIC = `Score the candidate answer from 0 to 5 on how well it answers the question about the FastAPI codebase, using the reference answer as ground truth.

5 — Correct and complete. Names the right functions, classes and modules, and describes the mechanism accurately. Nothing important missing, nothing invented.
4 — Correct, with a minor omission or slight imprecision. No false statements.
3 — Broadly correct direction but missing a key part of the mechanism, or vague where the reference is specific.
2 — Partially correct. Some right elements mixed with a wrong or unsupported claim.
1 — Mostly wrong, or states it cannot answer while the reference shows the answer was available.
0 — Wrong, empty, or fabricates code that does not exist.

Judge only correctness and completeness against the reference. Do not reward length, confidence or writing style. An answer that correctly states the context was insufficient scores 1, not 0.`;

export function buildJudgePrompt(question: string, reference: string, candidate: string): string {
  return `You are grading answers about the FastAPI source code.

${RUBRIC}

QUESTION:
${question}

REFERENCE ANSWER (ground truth):
${reference}

CANDIDATE ANSWER:
${candidate || '(empty)'}

Respond with exactly two lines and nothing else:
SCORE: <integer 0-5>
REASON: <one sentence>`;
}

export interface JudgeVerdict {
  score: number | null;
  rationale: string | null;
}

export function parseVerdict(text: string): JudgeVerdict {
  const score = text.match(/SCORE:\s*([0-5])/i);
  const reason = text.match(/REASON:\s*(.+)/i);
  return {
    score: score ? Number(score[1]) : null,
    rationale: reason ? reason[1].trim() : null,
  };
}

/** Score one answer. Returns null score if the judge output cannot be parsed,
 *  so an unparseable verdict is visibly missing rather than silently a zero. */
export async function scoreAnswer(question: string, reference: string, candidate: string): Promise<JudgeVerdict> {
  // No explicit cap: the judge model spends completion tokens on reasoning
  // before emitting, and a tight cap truncates the verdict away entirely.
  const res = await callJudge(buildJudgePrompt(question, reference, candidate));
  return parseVerdict(res.text);
}
