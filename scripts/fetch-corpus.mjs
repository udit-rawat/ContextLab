// Vendors the benchmark corpus: FastAPI source at a pinned commit.
//
// Pinned by SHA so every reported number reproduces even after upstream ships
// a release. Only fastapi/**/*.py is kept -- tests would push the corpus to
// ~1.1M tokens (outside the 100k-400k target band) and docs/ is 33MB of
// mostly translations.
//
//   npm run corpus
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { encode } from 'gpt-tokenizer';

const REPO = 'https://github.com/fastapi/fastapi.git';
const COMMIT = '66b2c5a9b5ddf65f218423072ad158e42ed780aa';
const SUBDIR = 'fastapi';
const DEST = join(process.cwd(), 'corpus', 'fastapi');

// -c core.autocrlf=false: a global autocrlf=true would rewrite the checkout to
// CRLF, inflating token counts and breaking byte-parity with upstream.
const run = (cmd, args, cwd) =>
  execFileSync(cmd, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.py')) out.push(p);
  }
  return out;
};

const tmp = mkdtempSync(join(tmpdir(), 'contextlab-corpus-'));
try {
  console.log(`Fetching ${REPO} @ ${COMMIT.slice(0, 7)} ...`);
  run('git', ['init', '-q', tmp]);
  run('git', ['remote', 'add', 'origin', REPO], tmp);
  run('git', ['fetch', '-q', '--depth', '1', 'origin', COMMIT], tmp);
  run('git', ['checkout', '-q', 'FETCH_HEAD'], tmp);

  const actual = run('git', ['rev-parse', 'HEAD'], tmp);
  if (actual !== COMMIT) throw new Error(`Commit mismatch: expected ${COMMIT}, got ${actual}`);

  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(dirname(DEST), { recursive: true });
  cpSync(join(tmp, SUBDIR), DEST, { recursive: true, filter: (src) => statSync(src).isDirectory() || src.endsWith('.py') });

  const files = walk(DEST).sort();
  let bytes = 0;
  let tokens = 0;
  const manifest = files.map((f) => {
    const text = readFileSync(f, 'utf8');
    const t = encode(text).length;
    bytes += Buffer.byteLength(text);
    tokens += t;
    return { path: `${SUBDIR}/${relative(DEST, f)}`, bytes: Buffer.byteLength(text), tokens: t };
  });

  writeFileSync(
    join(process.cwd(), 'corpus', 'manifest.json'),
    JSON.stringify({ repo: REPO, commit: COMMIT, include: `${SUBDIR}/**/*.py`, files: files.length, bytes, tokens, generatedBy: 'scripts/fetch-corpus.mjs', tokenizer: 'gpt-tokenizer (o200k_base) - approximate for Gemini; exact counts come from API usageMetadata', entries: manifest }, null, 2) + '\n',
  );

  const top = [...manifest].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  console.log(`\n  files   ${files.length}`);
  console.log(`  bytes   ${bytes.toLocaleString()}`);
  console.log(`  tokens  ${tokens.toLocaleString()}  (gpt-tokenizer, approximate for Gemini)`);
  console.log(`\n  largest files:`);
  for (const f of top) console.log(`    ${String(f.tokens).padStart(6)}  ${f.path}`);
  console.log(`\n  wrote corpus/manifest.json`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
