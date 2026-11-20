import path from 'path';
import fs from 'fs';
import { TrueForgeClient } from '../src/trueforge/client.js';
import { startMcpServer } from '../src/mcp/server.js';
import { globalEditStaging } from '../src/edit/staging.js';
import { applyHunks } from '../src/edit/hunks.js';
import { verifyTaskB } from './verify-task-b.js';

const FLASK_WORKSPACE = path.resolve('C:/Work/Projects/flask');

async function testTaskB() {
  console.log('\n=== RUNNING TASK B (MULTI-FILE AGENT MODE) ===\n');

  console.log('1. Starting MCP server on port 8795...');
  const mcp = await startMcpServer(FLASK_WORKSPACE, 8795);

  const client = new TrueForgeClient({
    baseUrl: 'http://localhost:8790',
    primaryModel: 'google-gemini/gemini-3-1-flash-lite',
    fallbackModel: 'groq/qwen-3-8-27b',
    mcpServerName: 'forgepilot',
    mcpServerUrl: 'http://127.0.0.1:8795/sse',
  });

  const instructions = `You are ForgePilot, a careful and highly disciplined coding assistant operating inside VS Code via TrueForge and localhost MCP tools.

CRITICAL CONTEXT SELECTION RULES:
1. Never dump whole files into context. Always search first with list_dir, search_text, or find_symbol.
2. When reading code, use read_file with targeted startLine and endLine ranges (max 400 lines).
3. BEFORE proposing any file edits, output a structured 'Context chosen' summary list:
   Context chosen:
   - <file_path>: <one-line explanation of why this file/symbol was chosen>

CRITICAL EDITING & SAFETY RULES:
1. NEVER attempt to write to disk silently. You MUST propose all changes using the propose_write tool.
2. For multi-file tasks (such as adding the 'flask config' command):
   - Propose changes to all 3 required files: implementation in src/flask/cli.py (or FlaskGroup), test in tests/test_cli.py, and documentation in docs/cli.rst.
3. When modifying existing files like src/flask/cli.py, you can use \`edits: [{ search: "...", replace: "..." }]\` for targeted search-and-replace, OR provide the full content. NEVER omit or truncate existing functions and classes in existing files.
4. Keep edits minimal, clean, and focused strictly on the user instruction.`;

  console.log('2. Creating TrueForge session...');
  const session = await client.createSession(client.getActiveModel(), instructions);
  console.log(`✓ Session created: ${session.id}`);

  const prompt =
    'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

  console.log('3. Streaming turn from model...');
  const appliedFiles: string[] = [];

  await client.runTurn(session.id, prompt, {
    onDelta: (text) => process.stdout.write(text),
    onToolApprovalRequired: (toolCallId, toolName, args) => {
      console.log(`\n[Approval Required] Tool: ${toolName}, path: ${args.path}`);
      if (toolName === 'propose_write') {
        const proposal = globalEditStaging.stageProposal(
          FLASK_WORKSPACE,
          args.path,
          args.newContent ?? '',
          toolCallId,
          args.edits
        );
        console.log(`✓ Staged proposal: ${proposal.proposalId} for ${proposal.relativePath} (${proposal.hunks.length} hunks)`);

        // Accept and apply hunks
        for (const h of proposal.hunks) {
          proposal.acceptedHunkIds.add(h.id);
        }
        const { newContent } = applyHunks(
          proposal.originalContent,
          proposal.hunks,
          Array.from(proposal.acceptedHunkIds)
        );
        fs.mkdirSync(path.dirname(proposal.fullPath), { recursive: true });
        fs.writeFileSync(proposal.fullPath, newContent, 'utf8');
        globalEditStaging.finalizeProposal(proposal.proposalId, proposal.hunks.length, proposal.hunks.length);
        appliedFiles.push(proposal.relativePath);
        console.log(`✓ Applied and saved to ${proposal.relativePath}`);

        // Resume approval in TrueForge turn so the agent loop continues to subsequent files
        client.resumeApproval(session.id, toolCallId, 'allow').catch((err) => {
          console.warn(`Approval resume notice: ${err.message}`);
        });
      }
    },
  });

  console.log('\n\n4. Verifying Task B on disk...');
  const vResult = verifyTaskB(FLASK_WORKSPACE);
  console.log(vResult.details.join('\n'));
  console.log(`\nApplied files: ${appliedFiles.join(', ')}`);
  console.log(`Task B Outcome: ${vResult.success ? 'PASSED ✓' : 'PARTIAL / PENDING'}`);

  await mcp.close();
  return vResult.success;
}

testTaskB()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('Error running Task B:', err);
    process.exit(1);
  });
