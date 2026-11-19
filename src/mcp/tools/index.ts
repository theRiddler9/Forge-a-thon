import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeListDir } from './listDir.js';
import { executeReadFile } from './readFile.js';
import { executeSearchText } from './searchText.js';
import { executeFindSymbol } from './findSymbol.js';
import { globalContextBudget } from './contextBudget.js';
import { executeProposeWrite } from './proposeWrite.js';
import { executeRunCommand } from './runCommand.js';

export function registerAllMcpTools(server: McpServer, workspaceRoot: string): void {
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

  // propose_write (Approval-gated, destructive hint)
  server.tool(
    'propose_write',
    'Propose an edit to a file. Edits are staged in memory and presented to the user for per-hunk review before touching disk.',
    {
      path: z.string().describe('Relative path of the file to modify or create'),
      newContent: z.string().describe('Full proposed new content for the file'),
      proposalId: z.string().optional().describe('Internal proposal ID when executing approved changes'),
    },
    { destructiveHint: true },
    async (args) => executeProposeWrite(workspaceRoot, args)
  );

  // run_command (Approval-gated, destructive hint)
  server.tool(
    'run_command',
    'Execute a terminal command in the workspace directory. Requires user approval.',
    {
      command: z.string().describe('Exact command line string to execute'),
      timeoutMs: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
    },
    { destructiveHint: true },
    async (args) => executeRunCommand(workspaceRoot, args)
  );
}

export const registerReadAndContextTools = registerAllMcpTools;
