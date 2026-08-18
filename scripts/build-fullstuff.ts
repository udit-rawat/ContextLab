/**
 * Precomputes the full-stuffing context and writes data/fullstuff.json.
 *
 * Two reasons this is a build step rather than runtime work:
 *
 *  1. The full-stuffing context does not depend on the question at all, so
 *     recomputing it per query is wasted work.
 *  2. The 128k cap has to be enforced in Gemini's tokens, not gpt-tokenizer's,
 *     and getting that exact needs live countTokens calls. Doing it once at
 *     build time keeps them off the query path.
 *
 * The result is a deterministic plan -- whole files plus a character offset
 * into the first file that did not fit -- so the context is reproducible from
 * the committed corpus without re-running this script.
 *
 *   npx tsx scripts/build-fullstuff.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer';
import { allFilesInPathOrder } from '../lib/store';
import { countGeminiTokens } from '../lib/llm';
import { CONTEXT_TOKEN_CAP, OUTPUT_TOKEN_RESERVE, ANSWER_MODEL } from '../config/models';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const BUDGET = CONTEXT_TOKEN_CAP - OUTPUT_TOKEN_RESERVE;

async function main() {
  const files = allFilesInPathOrder();
  const rendered = files.map((f) => ({ file: f.file, text: `# ${f.file}\n${f.text}` }));

  const estTotal = rendered.reduce((n, f) => n + encode(f.text).length, 0);
  const geminiTotal = await countGeminiTokens(rendered.map((f) => f.text).join('\n\n'));
  const ratio = geminiTotal / estTotal;
  console.log(`corpus: gpt-tokenizer=${estTotal.toLocaleString()}  gemini=${geminiTotal.toLocaleString()}  ratio=${ratio.toFixed(4)}`);
  console.log(`budget: ${BUDGET.toLocaleString()} gemini tokens\n`);

  // Greedily add whole files, using the calibrated ratio to predict cost, then
  // verify against countTokens. Prediction keeps the number of live calls small;
  // verification keeps the result exact.
  const whole: string[] = [];
  let assembled = '';
  let predicted = 0;
  let cutIndex = rendered.length;

  for (let i = 0; i < rendered.length; i++) {
    const cost = encode(rendered[i].text).length * ratio;
    if (predicted + cost > BUDGET) { cutIndex = i; break; }
    assembled = assembled ? `${assembled}\n\n${rendered[i].text}` : rendered[i].text;
    whole.push(rendered[i].file);
    predicted += cost;
  }

  let actual = await countGeminiTokens(assembled);
  console.log(`whole files: ${whole.length}  predicted=${Math.round(predicted).toLocaleString()}  actual=${actual.toLocaleString()}`);

  // Fill the remainder with a prefix of the first file that did not fit.
  let partial: { file: string; chars: number; tokens: number } | null = null;
  if (cutIndex < rendered.length && actual < BUDGET) {
    const next = rendered[cutIndex];
    let lo = 0;
    let hi = next.text.length;
    let bestChars = 0;
    let bestTokens = actual;

    // Binary search the character offset that lands just under budget.
    for (let step = 0; step < 8 && lo < hi; step++) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = `${assembled}\n\n${next.text.slice(0, mid)}`;
      const t = await countGeminiTokens(candidate);
      if (t <= BUDGET) { bestChars = mid; bestTokens = t; lo = mid + 1; } else { hi = mid; }
    }
    if (bestChars > 0) {
      partial = { file: next.file, chars: bestChars, tokens: bestTokens };
      actual = bestTokens;
    }
    console.log(`partial: ${next.file} -> ${bestChars.toLocaleString()} chars, total ${actual.toLocaleString()} tokens`);
  }

  const omitted = rendered.slice(cutIndex + (partial ? 1 : 0)).map((f) => f.file);
  const corpusGeminiTokens = geminiTotal;

  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(
    join(process.cwd(), 'data', 'fullstuff.json'),
    JSON.stringify({
      model: ANSWER_MODEL,
      budgetTokens: BUDGET,
      geminiTokens: actual,
      corpusGeminiTokens,
      tokenizerRatio: Number(ratio.toFixed(4)),
      wholeFiles: whole,
      partial,
      omittedFiles: omitted,
      droppedTokenShare: (corpusGeminiTokens - actual) / corpusGeminiTokens,
    }, null, 2) + '\n',
  );

  console.log(`\nwrote data/fullstuff.json`);
  console.log(`  whole files    ${whole.length}`);
  console.log(`  partial        ${partial ? `${partial.file} (${partial.chars} chars)` : '(none)'}`);
  console.log(`  omitted        ${omitted.length}`);
  console.log(`  gemini tokens  ${actual.toLocaleString()} / ${BUDGET.toLocaleString()} budget`);
  console.log(`  dropped        ${(((corpusGeminiTokens - actual) / corpusGeminiTokens) * 100).toFixed(1)}% of corpus`);
}
main().catch((e) => { console.error(e); process.exit(1); });
