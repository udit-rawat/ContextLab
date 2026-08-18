import { encode } from 'gpt-tokenizer';
import { parsePythonFile } from './python';

/**
 * The compressed repo skeleton: file tree plus signatures and docstrings, no
 * bodies.
 *
 * This is the artifact Strategy 4 always prepends. The bet is that a model
 * given the *shape* of the whole repo plus full text for a handful of relevant
 * chunks answers cross-file and architectural questions better than one given
 * only the chunks, at a fraction of the cost of the whole repo. Whether that
 * bet pays is the thing the benchmark measures, so the skeleton is built
 * honestly: no cherry-picking which files appear.
 */

export interface SkeletonFile {
  file: string;
  lines: string[];
  tokens: number;
}

/**
 * Reduce a signature to name, parameter names and return type.
 *
 * FastAPI annotates parameters as `Annotated[str, Doc("""...prose...""")]`,
 * so a verbatim-signature skeleton came out at 74,049 tokens: 48% of the whole
 * corpus, which would make Strategy 4 barely cheaper than full stuffing. That
 * is a property of this corpus, not of the idea, so the skeleton keeps the
 * structural part of each signature and drops the embedded documentation.
 * Both numbers are reported; the uncompacted one is a finding in its own right.
 */
export function compactSignature(signature: string): string {
  const open = signature.indexOf('(');
  if (open === -1) return signature;

  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return signature;

  const head = signature.slice(0, open);
  const paramText = signature.slice(open + 1, close);
  const tail = signature.slice(close + 1);

  const params: string[] = [];
  let buf = '';
  depth = 0;
  for (const ch of paramText) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { params.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) params.push(buf);

  const compact = params
    .map((raw) => {
      const p = raw.trim();
      if (!p) return '';
      if (p === '*' || p === '/' ) return p;
      const name = p.match(/^(\*{0,2}[A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (!name) return p.slice(0, 20);
      // Keep a short, self-contained annotation; drop anything carrying prose.
      const annMatch = p.slice(name.length).match(/^\s*:\s*([^=]+)/);
      const ann = annMatch?.[1]?.trim();
      // Require balanced brackets: the `[^=]+` capture above stops at the first
      // `=`, which can slice an annotation mid-expression into something short
      // enough to pass the length test but syntactically meaningless.
      const balanced =
        ann !== undefined &&
        [...ann].reduce((d, c) => d + (('([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0)), 0) === 0;
      const keepAnn = ann && balanced && ann.length <= 32 && !ann.includes('Doc(') && !ann.includes('"');
      return keepAnn ? `${name}: ${ann}` : name;
    })
    .filter(Boolean);

  // Return annotation is structural and usually short; keep it if it is.
  const retMatch = tail.match(/->\s*(.+?)\s*:\s*$/);
  const ret = retMatch?.[1];
  const keepRet = ret && ret.length <= 48 && !ret.includes('Doc(');

  return `${head}(${compact.join(', ')})${keepRet ? ` -> ${ret}` : ''}:`;
}

/** One file's signature-and-docstring outline. */
export function skeletonForFile(file: string, source: string): SkeletonFile {
  const symbols = parsePythonFile(source).sort((a, b) => a.startLine - b.startLine);
  const out: string[] = [`# ${file}`];

  for (const s of symbols) {
    const depth = s.qualName.split('.').length - 1;
    const pad = '    '.repeat(depth);
    for (const d of s.decorators) out.push(`${pad}@${d}`);
    out.push(`${pad}${compactSignature(s.signature)}`);
    if (s.docstring) out.push(`${pad}    """${s.docstring}"""`);
  }

  const lines = out.length > 1 ? out : [];
  return { file, lines, tokens: lines.length ? encode(lines.join('\n')).length : 0 };
}

/** Whole-repo skeleton, files in path order. */
export function buildSkeleton(files: { file: string; source: string }[]): {
  text: string;
  tokens: number;
  perFile: SkeletonFile[];
} {
  const perFile = files
    .map(({ file, source }) => skeletonForFile(file, source))
    .filter((f) => f.lines.length > 0);
  const text = perFile.map((f) => f.lines.join('\n')).join('\n\n');
  return { text, tokens: encode(text).length, perFile };
}
