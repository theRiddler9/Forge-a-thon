import fs from 'fs';
import path from 'path';
import { globalContextBudget } from './contextBudget.js';

export interface SearchTextArgs {
  query: string;
  glob?: string;
  maxHits?: number;
}

export const MAX_SEARCH_HITS = 40;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '__pycache__', '.pytest_cache', '.venv']);

export async function executeSearchText(
  workspaceRoot: string,
  args: SearchTextArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const query = args.query;
  const maxHits = args.maxHits ?? MAX_SEARCH_HITS;
  const lowerQuery = query.toLowerCase();

  const results: string[] = [];
  let hitsCount = 0;

  function walk(currentDir: string) {
    if (hitsCount >= maxHits) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (hitsCount >= maxHits) break;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (args.glob && !entry.name.includes(args.glob.replace(/\*/g, ''))) {
          continue;
        }

        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          // Skip binary files
          if (content.includes('\0')) continue;

          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              hitsCount++;
              const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
              const snippetStart = Math.max(0, i - 1);
              const snippetEnd = Math.min(lines.length - 1, i + 1);
              const snippet = lines.slice(snippetStart, snippetEnd + 1).map((l, sIdx) => {
                const num = snippetStart + sIdx + 1;
                return `  ${num}: ${l}`;
              }).join('\n');

              results.push(`${relPath}:${i + 1}\n${snippet}`);

              if (hitsCount >= maxHits) {
                results.push(`[Reached maximum limit of ${maxHits} hits. Narrow query with specific file glob or keywords.]`);
                break;
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(workspaceRoot);

  const outputText = results.length > 0 ? results.join('\n---\n') : `No matches found for query "${query}".`;
  const estimatedTokens = Math.ceil(outputText.length / 4);
  globalContextBudget.recordTokens('search_text', estimatedTokens, `Search "${query}"`);

  return {
    content: [{ type: 'text', text: outputText }],
  };
}
