import fs from 'fs';
import path from 'path';
import { globalContextBudget } from './contextBudget.js';

export interface FindSymbolArgs {
  name: string;
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '__pycache__', '.pytest_cache', '.venv']);

// Regex patterns for symbol definitions in Python, TypeScript/JavaScript, etc.
const SYMBOL_PATTERNS = [
  // Python: def foo / class Foo
  (name: string) => new RegExp(`^[ \\t]*(?:async\\s+)?def\\s+(${name})\\b`, 'i'),
  (name: string) => new RegExp(`^[ \\t]*class\\s+(${name})\\b`, 'i'),
  // JS/TS: function foo / class Foo / const foo = / interface Foo
  (name: string) => new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+(${name})\\b`, 'i'),
  (name: string) => new RegExp(`^[ \\t]*(?:export\\s+)?class\\s+(${name})\\b`, 'i'),
  (name: string) => new RegExp(`^[ \\t]*(?:export\\s+)?interface\\s+(${name})\\b`, 'i'),
  (name: string) => new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+(${name})\\s*=`, 'i'),
];

export async function executeFindSymbol(
  workspaceRoot: string,
  args: FindSymbolArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const symbolName = args.name.trim();
  const patterns = SYMBOL_PATTERNS.map((fn) => fn(symbolName));
  const matches: string[] = [];

  function walk(currentDir: string) {
    if (matches.length >= 30) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= 30) break;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.py', '.ts', '.js', '.jsx', '.tsx', '.go', '.rs'].includes(ext)) {
          continue;
        }

        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const isMatch = patterns.some((p) => p.test(line));
            if (isMatch) {
              const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
              const snippetStart = Math.max(0, i - 1);
              const snippetEnd = Math.min(lines.length - 1, i + 3);
              const snippet = lines.slice(snippetStart, snippetEnd + 1).map((l, idx) => {
                const lineNum = snippetStart + idx + 1;
                return `  ${lineNum}: ${l}`;
              }).join('\n');

              matches.push(`Symbol "${symbolName}" in ${relPath}:${i + 1}\n${snippet}`);
              if (matches.length >= 30) break;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(workspaceRoot);

  const outputText = matches.length > 0 ? matches.join('\n---\n') : `Symbol "${symbolName}" not found in workspace.`;
  const estimatedTokens = Math.ceil(outputText.length / 4);
  globalContextBudget.recordTokens(`find_symbol:${symbolName}`, estimatedTokens, `Symbol search`);

  return {
    content: [{ type: 'text', text: outputText }],
  };
}
