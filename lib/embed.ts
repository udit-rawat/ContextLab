import { EMBED_MODEL, EMBED_DIMENSIONS } from '../config/models';

/**
 * Gemini embeddings with two operational concessions to the free tier: a
 * fallback key engaged only on 429, and caller-driven batching. Both exist
 * because the daily request budget is small enough that one botched run would
 * cost a day of reruns.
 */

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}`;

/** RETRIEVAL_DOCUMENT and RETRIEVAL_QUERY are embedded into different spaces
 *  by design; using the matching task type on each side measurably improves
 *  retrieval over embedding both as plain text. */
export type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keys(): string[] {
  const k = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK].filter(Boolean) as string[];
  if (!k.length) throw new Error('GEMINI_API_KEY is not set');
  return k;
}

/** Embed a batch of texts. Returns vectors in input order. */
export async function embedBatch(texts: string[], taskType: TaskType): Promise<number[][]> {
  const body = {
    requests: texts.map((text) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBED_DIMENSIONS,
    })),
  };

  const available = keys();
  let lastError = '';

  for (let attempt = 0; attempt < 10; attempt++) {
    // Alternate keys rather than sticking on the last one: the two Gemini keys
    // belong to separate accounts, so a per-minute limit on one does not
    // imply a limit on the other.
    const key = available[attempt % available.length];
    const res = await fetch(`${ENDPOINT}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (res.ok) {
      const json = (await res.json()) as { embeddings: { values: number[] }[] };
      const out = json.embeddings.map((e) => e.values);
      if (out.length !== texts.length) throw new Error(`Expected ${texts.length} embeddings, got ${out.length}`);
      return out;
    }

    const text = await res.text();
    lastError = `HTTP ${res.status} ${text.slice(0, 200)}`;
    // 429 = quota. Switch keys immediately, then back off.
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(2 ** attempt * 1000, 60_000));
      continue;
    }
    throw new Error(`Embedding failed: ${lastError}`);
  }
  throw new Error(`Embedding failed after retries: ${lastError}`);
}

/** Float32 vector <-> base64. JSON number arrays would make the committed
 *  index roughly 2.4x larger for no benefit. */
export function encodeVector(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString('base64');
}

export function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Cosine similarity. Gemini embeddings are not unit-normalised at reduced
 *  dimensionality, so the norms are computed rather than assumed. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
