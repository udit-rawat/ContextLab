/**
 * Validates lib/python.ts against Python's own `ast` module.
 *
 * The chunker and the skeleton both sit on this parser, so if it drifts every
 * downstream number is wrong. Rather than trust a hand-rolled parser, this
 * shells out to python3, walks the real AST, and diffs symbol-for-symbol.
 *
 *   npx tsx scripts/verify-parser.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parsePythonFile } from '../lib/python';

const CORPUS = join(process.cwd(), 'corpus');

const PY_SCRIPT = `
import ast, json, pathlib
out = {}
for f in sorted(pathlib.Path('corpus/fastapi').rglob('*.py')):
    tree = ast.parse(f.read_text(encoding='utf-8'))
    syms = []
    def visit(node, scope):
        # Descend through every node, not just defs: FastAPI declares symbols
        # inside try/except and if TYPE_CHECKING blocks.
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                syms.append({
                    'qualName': '.'.join(scope + [child.name]),
                    'kind': 'class' if isinstance(child, ast.ClassDef) else 'function',
                    'startLine': child.lineno, 'endLine': child.end_lineno,
                    'doc': (ast.get_docstring(child) or '').split('\\n')[0].strip() or None,
                })
                visit(child, scope + [child.name])
            else:
                visit(child, scope)
    visit(tree, [])
    out[str(f).replace('corpus/', '')] = syms
print(json.dumps(out))
`;

interface TruthSymbol { qualName: string; kind: string; startLine: number; endLine: number; doc: string | null }

const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.py')) out.push(p);
  }
  return out;
};

const truth: Record<string, TruthSymbol[]> = JSON.parse(
  execFileSync('python3', ['-c', PY_SCRIPT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
);

let mineTotal = 0, truthTotal = 0, missing = 0, extra = 0, endOff = 0, kindMismatch = 0;
let docMatch = 0, docTotal = 0;
const problems: string[] = [];
const note = (s: string) => { if (problems.length < 15) problems.push(s); };

for (const abs of walk(CORPUS).sort()) {
  const rel = relative(CORPUS, abs);
  const t = truth[rel];
  if (!t) { note(`no ground truth for ${rel}`); continue; }

  const mine = parsePythonFile(readFileSync(abs, 'utf8'));
  mineTotal += mine.length;
  truthTotal += t.length;

  const byQual = new Map(mine.map((s) => [s.qualName, s]));
  const truthQuals = new Set(t.map((s) => s.qualName));

  for (const ts of t) {
    const ms = byQual.get(ts.qualName);
    if (!ms) { missing++; note(`MISSING  ${rel}:${ts.startLine} ${ts.qualName}`); continue; }
    if (ms.kind !== ts.kind) { kindMismatch++; note(`KIND     ${rel} ${ts.qualName}: ${ms.kind} vs ${ts.kind}`); }
    // endLine may differ by 1 where the AST excludes a trailing comment.
    if (Math.abs(ms.endLine - ts.endLine) > 1) { endOff++; note(`ENDLINE  ${rel} ${ts.qualName}: mine=${ms.endLine} truth=${ts.endLine}`); }
    if (ts.doc) {
      docTotal++;
      if (ms.docstring && (ts.doc.startsWith(ms.docstring.slice(0, 30)) || ms.docstring.startsWith(ts.doc.slice(0, 30)))) docMatch++;
      else note(`DOC      ${rel} ${ts.qualName}: mine=${JSON.stringify(ms.docstring?.slice(0, 40))} truth=${JSON.stringify(ts.doc.slice(0, 40))}`);
    }
  }
  for (const ms of mine) if (!truthQuals.has(ms.qualName)) { extra++; note(`EXTRA    ${rel} ${ms.qualName}`); }
}

console.log(`symbols    mine=${mineTotal}  ast=${truthTotal}`);
console.log(`missing    ${missing}  (in AST, not found by lib/python.ts)`);
console.log(`extra      ${extra}  (found by lib/python.ts, not in AST)`);
console.log(`kind       ${kindMismatch} mismatched`);
console.log(`endLine    ${endOff} off by more than 1`);
console.log(`docstring  ${docMatch}/${docTotal} matched`);
if (problems.length) { console.log('\nfirst problems:'); for (const p of problems) console.log('  ' + p); }

const fatal = missing + extra + kindMismatch;
console.log(fatal === 0 ? '\nParser agrees with the Python AST on every symbol.' : `\n${fatal} structural disagreement(s).`);
process.exit(fatal === 0 ? 0 : 1);
