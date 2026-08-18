// Preflight: validates the three free-tier API keys, confirms the pinned models
// are callable, and surfaces the two things that would silently corrupt the
// benchmark -- Gemini "thinking" tokens (non-deterministic cost) and embedding
// dimensionality (committed index size). Never prints key material.
//
//   node scripts/smoke.mjs
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { GEMINI_API_KEY, GEMINI_API_KEY_FALLBACK, GROQ_API_KEY } = process.env;
const GEM = 'https://generativelanguage.googleapis.com/v1beta/models';
const ANSWER_MODEL = 'gemini-3.1-flash-lite';
const EMBED_MODEL = 'gemini-embedding-001';
const JUDGE_MODEL = 'openai/gpt-oss-120b';
const EMBED_DIMS = 768;
const pad = (s, n) => String(s).padEnd(n);
const timed = (ms) => AbortSignal.timeout(ms);

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${pad(label, 34)} ${detail}`);
};

console.log('1. Keys present and distinct');
{
  const mask = (v) => (v ? `${v.slice(0, 6)}...${v.slice(-4)} (len ${v.length})` : 'MISSING');
  check('GEMINI_API_KEY', !!GEMINI_API_KEY, mask(GEMINI_API_KEY));
  check('GEMINI_API_KEY_FALLBACK', !!GEMINI_API_KEY_FALLBACK, mask(GEMINI_API_KEY_FALLBACK));
  check('GROQ_API_KEY', !!GROQ_API_KEY, mask(GROQ_API_KEY));
  check('Gemini keys are separate accounts', GEMINI_API_KEY !== GEMINI_API_KEY_FALLBACK,
    GEMINI_API_KEY === GEMINI_API_KEY_FALLBACK ? 'identical - no extra quota' : 'distinct');
}

console.log(`\n2. Answerer: ${ANSWER_MODEL} on both keys (thoughts must be 0 for reproducible cost)`);
for (const [label, key] of [['primary', GEMINI_API_KEY], ['fallback', GEMINI_API_KEY_FALLBACK]]) {
  try {
    const t0 = Date.now();
    const r = await fetch(`${GEM}/${ANSWER_MODEL}:generateContent`, {
      method: 'POST', signal: timed(25000),
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 500 } }),
    });
    const j = await r.json();
    const u = j.usageMetadata ?? {};
    const thoughts = u.thoughtsTokenCount ?? 0;
    check(`${label} key`, r.ok && !j.error && thoughts === 0,
      j.error ? j.error.message.slice(0, 60) : `${Date.now() - t0}ms prompt=${u.promptTokenCount} thoughts=${thoughts} out=${u.candidatesTokenCount}`);
  } catch (e) { check(`${label} key`, false, e.name); }
}

console.log(`\n3. Embeddings: ${EMBED_MODEL} truncated to ${EMBED_DIMS}d (keeps committed index small)`);
try {
  const t0 = Date.now();
  const r = await fetch(`${GEM}/${EMBED_MODEL}:embedContent`, {
    method: 'POST', signal: timed(25000),
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text: 'def add(a, b): return a + b' }] }, outputDimensionality: EMBED_DIMS }),
  });
  const j = await r.json();
  const dims = j?.embedding?.values?.length;
  check('embedContent', dims === EMBED_DIMS, dims ? `${Date.now() - t0}ms dimensions=${dims}` : j.error?.message?.slice(0, 60));
} catch (e) { check('embedContent', false, e.name); }

console.log(`\n4. Judge: ${JUDGE_MODEL} on Groq (different family from answerer)`);
try {
  const t0 = Date.now();
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal: timed(25000),
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 100 }),
  });
  const j = await r.json();
  check('chat/completions', r.ok, r.ok ? `${Date.now() - t0}ms total_tokens=${j.usage?.total_tokens}` : j.error?.message?.slice(0, 60));
  for (const [k, v] of r.headers) if (k.startsWith('x-ratelimit')) console.log(`        ${pad(k, 32)} ${v}`);
} catch (e) { check('chat/completions', false, e.name); }

console.log(failures === 0 ? '\nAll preflight checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
