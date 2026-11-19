import fs from 'fs';
import path from 'path';
import { executeReadFile } from '../mcp/tools/readFile.js';
import { executeFindSymbol } from '../mcp/tools/findSymbol.js';
import { globalContextBudget } from '../mcp/tools/contextBudget.js';

export interface ParsedMentions {
  fileMentions: string[];
  symbolMentions: string[];
  cleanedText: string;
}

export interface ResolvedContextItem {
  type: 'file' | 'symbol';
  target: string;
  content: string;
  lines?: string;
  tokens: number;
  reason: string;
}

export function parseMentions(input: string): ParsedMentions {
  const fileMentions: string[] = [];
  const symbolMentions: string[] = [];

  // Match @file:path/to/file or @file(path/to/file)
  const fileRegex = /@file(?::|\()([^\s\)]+)\)?/gi;
  let fileMatch;
  while ((fileMatch = fileRegex.exec(input)) !== null) {
    fileMentions.push(fileMatch[1].replace(/['"]/g, ''));
  }

  // Match @symbol:name or @symbol(name)
  const symbolRegex = /@symbol(?::|\()([^\s\)]+)\)?/gi;
  let symbolMatch;
  while ((symbolMatch = symbolRegex.exec(input)) !== null) {
    symbolMentions.push(symbolMatch[1].replace(/['"]/g, ''));
  }

  const cleanedText = input
    .replace(fileRegex, '')
    .replace(symbolRegex, '')
    .trim();

  return {
    fileMentions,
    symbolMentions,
    cleanedText,
  };
}

export async function resolveMentions(
  workspaceRoot: string,
  mentions: { fileMentions: string[]; symbolMentions: string[] }
): Promise<ResolvedContextItem[]> {
  const resolved: ResolvedContextItem[] = [];

  // Resolve file mentions
  for (const relPath of mentions.fileMentions) {
    const fullPath = path.resolve(workspaceRoot, relPath);
    if (fs.existsSync(fullPath)) {
      const readResult = await executeReadFile(workspaceRoot, { path: relPath, startLine: 1, endLine: 400 });
      const content = readResult.content[0].text;
      const tokens = Math.ceil(content.length / 4);

      resolved.push({
        type: 'file',
        target: relPath,
        content,
        lines: '1-400',
        tokens,
        reason: `Explicitly mentioned via @file:${relPath}`,
      });
    }
  }

  // Resolve symbol mentions
  for (const sym of mentions.symbolMentions) {
    const findResult = await executeFindSymbol(workspaceRoot, { name: sym });
    const content = findResult.content[0].text;
    const tokens = Math.ceil(content.length / 4);

    resolved.push({
      type: 'symbol',
      target: sym,
      content,
      tokens,
      reason: `Explicitly mentioned via @symbol:${sym}`,
    });
  }

  return resolved;
}

export function formatContextBlock(items: ResolvedContextItem[]): string {
  if (items.length === 0) return '';

  const totalTokens = items.reduce((acc, it) => acc + it.tokens, 0);
  const budgetInfo = globalContextBudget.getBudgetInfo();

  const lines = [
    `=== Context Chosen (Budget: ${budgetInfo.totalBudget} tokens | Attached: ${totalTokens} tokens) ===`,
    ...items.map((it) => {
      const typeLabel = it.type === 'file' ? `File [${it.target}]` : `Symbol [${it.target}]`;
      const linesInfo = it.lines ? ` (Lines: ${it.lines})` : '';
      return `${typeLabel}${linesInfo} - Reason: ${it.reason}\n${it.content}\n---`;
    }),
    `=== End Context Chosen ===\n`,
  ];

  return lines.join('\n');
}
