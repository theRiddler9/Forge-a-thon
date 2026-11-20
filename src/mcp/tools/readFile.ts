import fs from 'fs';
import path from 'path';
import { globalContextBudget } from './contextBudget.js';
import { resolveInWorkspace, WorkspaceEscapeError } from './pathGuard.js';

export interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

export const MAX_READ_LINES = 400;

export async function executeReadFile(
  workspaceRoot: string,
  args: ReadFileArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let fullPath: string;
  try {
    fullPath = resolveInWorkspace(workspaceRoot, args.path);
  } catch (err) {
    if (err instanceof WorkspaceEscapeError) {
      return { content: [{ type: 'text', text: err.message }] };
    }
    throw err;
  }
  const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');

  if (!fs.existsSync(fullPath)) {
    return {
      content: [{ type: 'text', text: `File not found: ${args.path}` }],
    };
  }

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(fullPath, 'utf8');
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Failed to read file ${args.path}: ${err.message}` }],
    };
  }

  const allLines = fileContent.split(/\r?\n/);
  const totalLines = allLines.length;

  const start = Math.max(1, args.startLine ?? 1);
  const requestedEnd = Math.min(totalLines, args.endLine ?? totalLines);
  const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1);

  const selectedLines = allLines.slice(start - 1, end);
  const formattedLines = selectedLines.map((line, idx) => {
    const lineNum = start + idx;
    return `${String(lineNum).padStart(4, ' ')} | ${line}`;
  });

  let outputText = formattedLines.join('\n');

  if (end < totalLines && (!args.endLine || requestedEnd > end)) {
    const remaining = totalLines - end;
    outputText += `\n[... ${remaining} more lines truncated. Specify startLine and endLine to read more ...]`;
  }

  // Estimate tokens (~4 characters per token)
  const estimatedTokens = Math.ceil(outputText.length / 4);
  globalContextBudget.recordTokens(relPath, estimatedTokens, `Read lines ${start}-${end}`);

  return {
    content: [{ type: 'text', text: outputText }],
  };
}
