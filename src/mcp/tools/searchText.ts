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

/**
 * Matches a relative file path against a glob pattern.
 *
 * Supported patterns:
 *   *.ext       — extension match; the basename must END with ".ext" (not just contain it,
 *                 so "*.py" does NOT match "notes.pyc").
 *   dir/*.ext   — files directly under a specific directory prefix.
 *   literal     — substring match on the basename (fallback for other patterns).
 */
function matchGlob(relPath: string, basename: string, glob: string): boolean {
  const normalizedRel = relPath.replace(/\\/g, '/');

  if (glob.includes('/')) {
    // Path-qualified glob: "dir/*.ext" or "src/sub/*.ts"
    const slashIdx = glob.lastIndexOf('/');
    const dirPrefix = glob.slice(0, slashIdx);
    const pattern = glob.slice(slashIdx + 1);
    if (!normalizedRel.startsWith(dirPrefix + '/')) return false;
    if (pattern.startsWith('*')) {
      const ext = pattern.slice(1); // e.g. '.py'
      return ext === '' || (basename.endsWith(ext) && basename.length > ext.length);
    }
    return basename === pattern;
  }

  if (glob.startsWith('*')) {
    // Simple extension glob: "*.py" — exact suffix match, not substring
    const ext = glob.slice(1); // e.g. '.py'
    if (ext === '') return true; // "*" matches everything
    return basename.endsWith(ext) && basename.length > ext.length;
  }

  // Literal or other pattern — substring match on basename for compatibility
  return basename.includes(glob);
}

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
      const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (args.glob && !matchGlob(relPath, entry.name, args.glob)) {
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
  const finalText = globalContextBudget.enforceOutput(outputText, 'search_text', `Search "${query}"`);

  return {
    content: [{ type: 'text', text: finalText }],
  };
}
