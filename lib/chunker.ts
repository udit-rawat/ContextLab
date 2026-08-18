import { encode } from 'gpt-tokenizer';
import { parsePythonFile, type PySymbol } from './python';
import { MAX_CHUNK_TOKENS } from '../config/models';

/**
 * Chunking on symbol boundaries rather than fixed windows.
 *
 * A fixed 400-token window cuts through the middle of functions, so a
 * retrieved chunk routinely opens mid-body with no signature and no context.
 * Splitting on def/class boundaries means every chunk is a unit a model can
 * actually reason about, and every chunk can name the symbol it came from,
 * which is what makes citation scoring possible.
 */

export interface Chunk {
  id: string;
  /** Repo-relative path, e.g. `fastapi/routing.py`. */
  file: string;
  startLine: number;
  endLine: number;
  /** Dotted symbol path, or null for module-level code. */
  symbol: string | null;
  kind: 'function' | 'class' | 'module';
  /** Source text, verbatim. */
  text: string;
  tokens: number;
}

const countTokens = (s: string): number => encode(s).length;

/** Slice source lines, 1-indexed inclusive. */
const slice = (lines: string[], from: number, to: number): string =>
  lines.slice(from - 1, to).join('\n');

/**
 * Split an oversized block by line count, keeping a small overlap so a
 * definition split across the seam still appears whole in one of the pieces.
 */
function splitOversized(
  lines: string[],
  from: number,
  to: number,
  budget: number,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let cursor = from;
  while (cursor <= to) {
    let end = cursor;
    let tokens = 0;
    while (end <= to) {
      const next = tokens + countTokens(lines[end - 1] ?? '') + 1;
      if (next > budget && end > cursor) break;
      tokens = next;
      end++;
    }
    out.push({ from: cursor, to: Math.min(end - 1, to) });
    if (end - 1 >= to) break;
    cursor = end;
  }
  return out;
}

/** Direct children of `parent` — one nesting level down, no deeper. */
function directChildren(symbols: PySymbol[], parent: PySymbol): PySymbol[] {
  const depth = parent.qualName.split('.').length;
  return symbols.filter(
    (s) =>
      s !== parent &&
      s.startLine > parent.startLine &&
      s.endLine <= parent.endLine &&
      s.qualName.startsWith(parent.qualName + '.') &&
      s.qualName.split('.').length === depth + 1,
  );
}

export function chunkPythonFile(file: string, source: string): Chunk[] {
  const lines = source.split('\n');
  const symbols = parsePythonFile(source);
  const topLevel = symbols.filter((s) => s.indent === 0).sort((a, b) => a.startLine - b.startLine);
  const chunks: Chunk[] = [];

  const push = (from: number, to: number, symbol: string | null, kind: Chunk['kind']) => {
    const text = slice(lines, from, to);
    if (!text.trim()) return;
    chunks.push({
      id: `${file}:${from}-${to}`,
      file,
      startLine: from,
      endLine: to,
      symbol,
      kind,
      text,
      tokens: countTokens(text),
    });
  };

  // Module-level code (imports, constants) in the gaps between top-level
  // symbols. Kept because "what does this module import" is a real question.
  let cursor = 1;
  const emitGap = (upto: number) => {
    if (upto >= cursor) {
      const text = slice(lines, cursor, upto);
      if (text.trim()) {
        for (const part of splitOversized(lines, cursor, upto, MAX_CHUNK_TOKENS)) {
          push(part.from, part.to, null, 'module');
        }
      }
    }
  };

  for (const sym of topLevel) {
    emitGap(sym.startLine - 1);
    const tokens = countTokens(slice(lines, sym.startLine, sym.endLine));

    if (tokens <= MAX_CHUNK_TOKENS) {
      push(sym.startLine, sym.endLine, sym.qualName, sym.kind);
    } else {
      // Too big: split on its own children (usually methods of a class) so the
      // pieces are still whole symbols.
      const children = directChildren(symbols, sym).sort((a, b) => a.startLine - b.startLine);
      if (children.length === 0) {
        for (const part of splitOversized(lines, sym.startLine, sym.endLine, MAX_CHUNK_TOKENS)) {
          push(part.from, part.to, sym.qualName, sym.kind);
        }
      } else {
        // Header (class line + docstring + attributes) up to the first child.
        push(sym.startLine, children[0].startLine - 1, sym.qualName, sym.kind);
        for (let i = 0; i < children.length; i++) {
          const c = children[i];
          const end = i + 1 < children.length ? children[i + 1].startLine - 1 : sym.endLine;
          const childTokens = countTokens(slice(lines, c.startLine, end));
          if (childTokens <= MAX_CHUNK_TOKENS) {
            push(c.startLine, end, c.qualName, c.kind);
          } else {
            for (const part of splitOversized(lines, c.startLine, end, MAX_CHUNK_TOKENS)) {
              push(part.from, part.to, c.qualName, c.kind);
            }
          }
        }
      }
    }
    cursor = sym.endLine + 1;
  }
  emitGap(lines.length);

  return chunks.sort((a, b) => a.startLine - b.startLine);
}

/** Text handed to the embedder and to the model, prefixed so the model can cite. */
export function chunkHeader(c: Chunk): string {
  const label = c.symbol ? ` (${c.symbol})` : '';
  return `# ${c.file}:${c.startLine}-${c.endLine}${label}\n${c.text}`;
}
