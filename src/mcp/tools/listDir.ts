import fs from 'fs';
import path from 'path';

export interface ListDirArgs {
  relativePath?: string;
  maxDepth?: number;
}

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '__pycache__', '.pytest_cache', '.venv']);

export async function executeListDir(
  workspaceRoot: string,
  args: ListDirArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const targetRel = args.relativePath ?? '.';
  const targetDir = path.resolve(workspaceRoot, targetRel);
  const maxDepth = args.maxDepth ?? 3;

  if (!fs.existsSync(targetDir)) {
    return {
      content: [{ type: 'text', text: `Directory not found: ${targetRel}` }],
    };
  }

  const lines: string[] = [];

  function walk(currentDir: string, currentDepth: number) {
    if (currentDepth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err: any) {
      lines.push(`Error reading ${path.relative(workspaceRoot, currentDir)}: ${err.message}`);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        lines.push(`${relPath}/`);
        walk(fullPath, currentDepth + 1);
      } else {
        try {
          const stat = fs.statSync(fullPath);
          lines.push(`${relPath} (${stat.size} bytes)`);
        } catch {
          lines.push(relPath);
        }
      }
    }
  }

  walk(targetDir, 1);

  return {
    content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '(empty directory)' }],
  };
}
