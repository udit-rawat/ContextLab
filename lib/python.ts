/**
 * Minimal structural parser for Python source.
 *
 * Node has no Python AST, but Python's significant indentation makes the
 * structure recoverable without one: a def/class block runs until the next
 * non-blank line indented at or below the header. That is enough to chunk on
 * real symbol boundaries and to build the signature+docstring skeleton, which
 * are the only two things the benchmark needs.
 *
 * Correctness is not assumed. scripts/verify-parser.ts diffs every symbol this
 * produces against Python's own `ast` module over the pinned corpus, and fails
 * the build on any structural disagreement.
 */

export type SymbolKind = 'function' | 'class' | 'module';

export interface PySymbol {
  kind: SymbolKind;
  /** Bare name, e.g. `get_route_handler`. */
  name: string;
  /** Dotted path including every enclosing scope, e.g. `APIRoute.get_route_handler`. */
  qualName: string;
  /** 1-indexed, inclusive. Includes any decorators. */
  startLine: number;
  /** 1-indexed, inclusive. */
  endLine: number;
  /** Indent column of the `def`/`class` keyword. */
  indent: number;
  /** Full signature joined to one line, e.g. `def f(a: int) -> None:` */
  signature: string;
  /** First line of the docstring, if any. */
  docstring: string | null;
  /** Decorator lines, without the leading `@`. */
  decorators: string[];
}

const DEF_RE = /^(\s*)(?:(async)\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const DECORATOR_RE = /^(\s*)@(.+)$/;

const DQ = '"'.repeat(3);
const SQ = "'".repeat(3);

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '';
const isComment = (line: string): boolean => line.trim().startsWith('#');

/**
 * Mark which lines *begin* inside a triple-quoted string.
 *
 * This matters more than it sounds. FastAPI's docstrings embed large python
 * examples containing real `def` and `class` statements. Without this mask a
 * regex parser reports those examples as members of the enclosing class: on the
 * pinned corpus it inflated the symbol count from 480 to 554 and produced
 * runaway block ends spanning thousands of lines.
 */
function computeStringMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let open: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    mask[i] = open !== null;
    const line = lines[i];
    let col = 0;
    while (col < line.length) {
      if (open !== null) {
        const close = line.indexOf(open, col);
        if (close === -1) break;
        col = close + 3;
        open = null;
      } else {
        const d = line.indexOf(DQ, col);
        const s = line.indexOf(SQ, col);
        if (d === -1 && s === -1) break;
        const next = d === -1 ? s : s === -1 ? d : Math.min(d, s);
        open = line.startsWith(DQ, next) ? DQ : SQ;
        col = next + 3;
      }
    }
  }
  return mask;
}

/**
 * Strip a trailing `#` comment, respecting quotes so a `#` inside a string
 * literal survives.
 *
 * Needed because FastAPI writes headers like `class Color:  # type: ignore`.
 * Without stripping, the header does not end in `:` and signature detection
 * runs on to the next colon line, corrupting the symbol's line range.
 */
function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Walk forward from a def/class header to the line closing its signature,
 * tracking bracket depth so multi-line parameter lists are handled.
 */
function findSignatureEnd(lines: string[], start: number, inString: boolean[]): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    // FastAPI writes Doc(...) blocks inside parameter lists, so the signature
    // region contains prose with stray brackets, quotes and '#'. Lines that
    // begin inside such a string are not code and must be skipped.
    if (inString[i]) continue;

    const line = lines[i];
    let quote: string | null = null;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (quote) {
        if (ch === '\\') c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '#') break;
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      // The colon closing the header need not be last on the line: Protocol
      // stubs are written `def dumps(self) -> str: ...` with the body inline.
      else if (ch === ':' && depth <= 0) return i;
    }
  }
  return start;
}


/** First line of the docstring beginning at `start`, if one is there. */
function extractDocstring(lines: string[], start: number): string | null {
  let i = start;
  while (i < lines.length && isBlank(lines[i])) i++;
  if (i >= lines.length) return null;

  const trimmed = lines[i].trim();
  const quote = trimmed.startsWith(DQ) ? DQ : trimmed.startsWith(SQ) ? SQ : null;
  if (!quote) return null;

  const afterOpen = trimmed.slice(3);
  const closeIdx = afterOpen.indexOf(quote);
  if (closeIdx !== -1) return afterOpen.slice(0, closeIdx).trim() || null;
  if (afterOpen.trim()) return afterOpen.trim();

  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t.startsWith(quote)) return null;
    if (t) return t.endsWith(quote) ? t.slice(0, -3).trim() : t;
  }
  return null;
}

/**
 * Last line belonging to a block whose header sits at `headerIndent`.
 * Lines inside triple-quoted strings are carried through regardless of their
 * apparent indent, since a dedented line in a docstring example would
 * otherwise close the block early.
 */
function findBlockEnd(lines: string[], bodyStart: number, headerIndent: number, inString: boolean[]): number {
  let end = bodyStart - 1;
  for (let i = bodyStart; i < lines.length; i++) {
    if (inString[i]) { end = i; continue; }
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= headerIndent) break;
    end = i;
  }
  return end;
}

export function parsePythonFile(source: string): PySymbol[] {
  const lines = source.split('\n');
  const inString = computeStringMask(lines);
  const symbols: PySymbol[] = [];
  // Scope is popped by line containment, not indent: a nested def can sit
  // deeper than a preceding sibling (inside an `if` block) without being
  // nested within it, which pure indentation cannot distinguish.
  const scope: { name: string; endLine: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (inString[i]) continue;
    const m = DEF_RE.exec(lines[i]);
    if (!m) continue;

    const [, indentStr, , keyword, name] = m;
    const indent = indentStr.length;

    const decorators: string[] = [];
    let headerStart = i;
    for (let j = i - 1; j >= 0; j--) {
      if (isBlank(lines[j])) continue;
      if (inString[j]) break;
      const d = DECORATOR_RE.exec(lines[j]);
      if (!d || d[1].length !== indent) break;
      decorators.unshift(d[2].trim());
      headerStart = j;
    }

    const sigEnd = findSignatureEnd(lines, i, inString);
    const signature = lines
      .slice(i, sigEnd + 1)
      .map((l) => l.trim())
      .join(' ')
      .replace(/\s+/g, ' ');

    const endLine = Math.max(findBlockEnd(lines, sigEnd + 1, indent, inString) + 1, sigEnd + 1);

    while (scope.length && scope[scope.length - 1].endLine < i + 1) scope.pop();

    symbols.push({
      kind: keyword === 'class' ? 'class' : 'function',
      name,
      qualName: [...scope.map((s) => s.name), name].join('.'),
      startLine: headerStart + 1,
      endLine,
      indent,
      signature,
      docstring: extractDocstring(lines, sigEnd + 1),
      decorators,
    });

    // Push for functions too: nested defs are common in FastAPI (decorator
    // factories), and class-only scoping collides their qualified names.
    scope.push({ name, endLine });
  }

  return symbols;
}

/** Top-level symbols only (indent 0), in source order. */
export function topLevelSymbols(symbols: PySymbol[]): PySymbol[] {
  return symbols.filter((s) => s.indent === 0);
}
