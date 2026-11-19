import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeListDir } from './listDir.js';
import { executeReadFile } from './readFile.js';
import { executeSearchText } from './searchText.js';
import { executeFindSymbol } from './findSymbol.js';
import { globalContextBudget } from './contextBudget.js';

export function registerReadAndContextTools(server: McpServer, workspaceRoot: string): void {
  // list_dir
  server.tool(
    'list_dir',
    'List files and directories in a workspace directory',
    {
      relativePath: z.string().optional().describe('Relative path to directory from workspace root (default: .)'),
      maxDepth: z.number().optional().describe('Maximum folder traversal depth (default: 3)'),
    },
    { readOnlyHint: true },
    async (args) => executeListDir(workspaceRoot, args)
  );

  // read_file
  server.tool(
    'read_file',
    'Read content of a file with line numbers and optional range',
    {
      path: z.string().describe('Relative file path from workspace root'),
      startLine: z.number().optional().describe('1-based starting line number'),
      endLine: z.number().optional().describe('1-based ending line number (capped at 400 lines max per read)'),
    },
    { readOnlyHint: true },
    async (args) => executeReadFile(workspaceRoot, args)
  );

  // search_text
  server.tool(
    'search_text',
    'Search for text or regex across workspace files with line numbers and snippets',
    {
      query: z.string().describe('Search query string'),
      glob: z.string().optional().describe('Optional file pattern filter (e.g. *.py)'),
      maxHits: z.number().optional().describe('Max hits to return (default: 40)'),
    },
    { readOnlyHint: true },
    async (args) => executeSearchText(workspaceRoot, args)
  );

  // find_symbol
  server.tool(
    'find_symbol',
    'Find function, class, or type definition for a symbol name',
    {
      name: z.string().describe('Symbol name to locate'),
    },
    { readOnlyHint: true },
    async (args) => executeFindSymbol(workspaceRoot, args)
  );

  // get_context_budget_info
  server.tool(
    'get_context_budget_info',
    'Get telemetry on current turn context token budget, tokens used, and remaining budget',
    {},
    { readOnlyHint: true },
    async () => {
      const info = globalContextBudget.getBudgetInfo();
      return {
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      };
    }
  );
}
