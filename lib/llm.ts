import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANSWER_MODEL, JUDGE_MODEL, OUTPUT_TOKEN_RESERVE, costUsd } from '../config/models';

/**
 * Model calls with three pieces of machinery the free tier forces on us.
 *
 * 1. A response cache keyed on (model, prompt, params). The answerer allows
 *    ~250 requests/day and a full benchmark run is 56, so an uncached rerun
 *    after a one-line change would burn a fifth of the daily budget. With the
 *    cache, changing one strategy re-runs only that strategy.
 * 2. Request pacing. Free-tier limits are per-minute, so requests are spaced
 *    rather than fired in parallel.
 * 3. Key rotation on 429. The two Gemini keys are separate accounts with
 *    independent quotas.
 *
 * Token counts and latency always come from the live call. A cache hit reports
 * the tokens recorded when the call was actually made, and is flagged as cached
 * so latency from cached rows is never averaged into reported timings.
 */

/**
 * Serverless filesystems are read-only apart from /tmp, so a cache rooted at
 * the working directory makes every live request fail with ENOENT -- while
 * working perfectly in local development, which is exactly how it reached
 * production unnoticed. On Vercel the cache moves to /tmp, where it still
 * helps: it survives for the life of a warm container, so a repeated question
 * costs nothing.
 */
const ON_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const CACHE_DIR = ON_SERVERLESS
  ? join(tmpdir(), 'contextlab-responses')
  : join(process.cwd(), '.cache', 'responses');

export interface LlmResult {
  text: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  /** Reasoning tokens. Asserted to be 0 for the pinned answerer; tracked so a
   *  silent model change cannot corrupt cost figures unnoticed. */
  thoughtTokens: number;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);

function geminiKeys(): string[] {
  const k = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK].filter(Boolean) as string[];
  if (!k.length) throw new Error('GEMINI_API_KEY is not set');
  return k;
}

/** Cache access never fails a request. A cache is an optimisation; if the
 *  filesystem refuses, the call simply costs a request. */
function cacheRead(key: string): LlmResult | null {
  try {
    const p = join(CACHE_DIR, `${key}.json`);
    if (!existsSync(p)) return null;
    return { ...(JSON.parse(readFileSync(p, 'utf8')) as LlmResult), cached: true };
  } catch {
    return null;
  }
}

function cacheWrite(key: string, value: LlmResult): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
  } catch {
    // Read-only filesystem or disk pressure: not worth failing the call over.
  }
}

/** Serialises calls and enforces a minimum gap, since free-tier limits are per-minute. */
class Pacer {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private minGapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.minGapMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this.last = Date.now(); }
    });
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }
}

const geminiPacer = new Pacer(4_000);
// Groq's free tier allows 8,000 tokens per minute. A judge call carries roughly
// 1,500 prompt tokens, so anything faster than ~13s between calls exceeds the
// token budget rather than the request budget, and every call after the first
// few 429s.
const groqPacer = new Pacer(13_000);

/** Answer generation. Same entry point for every strategy. */
export async function generate(prompt: string, opts: { maxOutputTokens?: number; noCache?: boolean } = {}): Promise<LlmResult> {
  const maxOutputTokens = opts.maxOutputTokens ?? OUTPUT_TOKEN_RESERVE;
  const key = hash(`${ANSWER_MODEL}|${maxOutputTokens}|${prompt}`);
  if (!opts.noCache) {
    const hit = cacheRead(key);
    if (hit) return hit;
  }

  const keys = geminiKeys();
  let lastError = '';

  for (let attempt = 0; attempt < 8; attempt++) {
    const apiKey = keys[attempt % keys.length];
    const t0 = Date.now();
    const res = await geminiPacer.run(() =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${ANSWER_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens, temperature: 0 } }),
        signal: AbortSignal.timeout(180_000),
      }),
    );
    const latencyMs = Date.now() - t0;

    if (res.ok) {
      const j = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const u = j.usageMetadata ?? {};
      const result: LlmResult = {
        text,
        model: ANSWER_MODEL,
        promptTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        thoughtTokens: u.thoughtsTokenCount ?? 0,
        costUsd: costUsd(ANSWER_MODEL, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)),
        latencyMs,
        cached: false,
      };
      cacheWrite(key, result);
      return result;
    }

    lastError = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429 || res.status >= 500) { await sleep(Math.min(2 ** attempt * 1000, 60_000)); continue; }
    throw new Error(`generate failed: ${lastError}`);
  }
  throw new Error(`generate failed after retries: ${lastError}`);
}

/** Judge calls run on Groq: a different model family from the answerer, so the
 *  judge cannot prefer its own generations. */
export async function judge(prompt: string, opts: { maxOutputTokens?: number } = {}): Promise<LlmResult> {
  // gpt-oss-120b is a reasoning model: it spends completion tokens thinking
  // before it emits anything. At max_tokens 200 the reasoning consumed the whole
  // budget and 50 of 56 verdicts came back empty or truncated mid-word, which
  // looked like a parsing bug rather than a truncation one. reasoning_effort
  // 'low' cuts thinking to ~20 tokens for this task, and the ceiling is raised
  // so a verdict can never be cut off again.
  const maxOutputTokens = opts.maxOutputTokens ?? 800;
  const key = hash(`${JUDGE_MODEL}|${maxOutputTokens}|${prompt}`);
  const hit = cacheRead(key);
  if (hit) return hit;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');
  let lastError = '';

  for (let attempt = 0; attempt < 8; attempt++) {
    const t0 = Date.now();
    const res = await groqPacer.run(() =>
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxOutputTokens,
          temperature: 0,
          reasoning_effort: 'low',
        }),
        signal: AbortSignal.timeout(120_000),
      }),
    );
    const latencyMs = Date.now() - t0;

    if (res.ok) {
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
      };
      const result: LlmResult = {
        text: j.choices?.[0]?.message?.content ?? '',
        model: JUDGE_MODEL,
        promptTokens: j.usage?.prompt_tokens ?? 0,
        outputTokens: j.usage?.completion_tokens ?? 0,
        // Groq counts reasoning inside completion_tokens, so cost is already correct.
        thoughtTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        costUsd: costUsd(JUDGE_MODEL, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0),
        latencyMs,
        cached: false,
      };
      cacheWrite(key, result);
      return result;
    }

    lastError = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429 || res.status >= 500) { await sleep(Math.min(2 ** attempt * 1000, 60_000)); continue; }
    throw new Error(`judge failed: ${lastError}`);
  }
  throw new Error(`judge failed after retries: ${lastError}`);
}

/**
 * Exact prompt-token count from Gemini's own tokenizer.
 *
 * gpt-tokenizer is a good local approximation but it is not Gemini's
 * tokenizer: on this corpus it under-counts by roughly 20%, which is enough to
 * push a context built to a "128k" budget over the real limit. Anywhere the cap
 * actually binds, the count has to come from here. countTokens is free and sits
 * on a separate quota from generateContent.
 */
export async function countGeminiTokens(text: string): Promise<number> {
  const keys = geminiKeys();
  let lastError = '';

  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await geminiPacer.run(() =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${ANSWER_MODEL}:countTokens`, {
        method: 'POST',
        headers: { 'x-goog-api-key': keys[attempt % keys.length], 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
        signal: AbortSignal.timeout(120_000),
      }),
    );
    if (res.ok) return ((await res.json()) as { totalTokens: number }).totalTokens;
    lastError = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status === 429 || res.status >= 500) { await sleep(Math.min(2 ** attempt * 1000, 60_000)); continue; }
    throw new Error(`countTokens failed: ${lastError}`);
  }
  throw new Error(`countTokens failed after retries: ${lastError}`);
}
