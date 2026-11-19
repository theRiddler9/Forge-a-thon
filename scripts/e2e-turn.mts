import { TrueForge } from '@truefoundry/trueforge-sdk';
import { startMcpServer } from '../src/mcp/server.js';

const WORKSPACE = 'C:/Work/Projects/flask';
const MODEL = process.argv[2] ?? 'groq/openai-gpt-oss-120b';

(async () => {
  console.log('1. Starting MCP server for', WORKSPACE);
  const mcp = await startMcpServer({ workspaceRoot: WORKSPACE });
  console.log('   MCP url:', mcp.url);

  const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 300 });

  console.log('2. Registering MCP server in TrueForge');
  await (client.settings.mcpServers as any).createOrUpdate({
    manifest: {
      name: 'forgepilot',
      type: 'remote',
      description: 'ForgePilot in-process editor tools',
      url: mcp.url,
    },
  });

  console.log('3. Creating session with', MODEL);
  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL },
        instructions:
          'You are ForgePilot, an expert coding assistant. Before proposing file edits, pick the minimal context you need using the available MCP tools (list_dir, read_file, search_text, find_symbol). Answer briefly.',
        mcpServers: [
          {
            name: 'forgepilot',
            enableTools: ['@all'],
            requireApprovalForTools: ['@destructive', '@write', 'propose_write', 'run_command'],
            preload: false,
            preloadTools: ['list_dir', 'read_file', 'search_text', 'find_symbol', 'get_context_budget_info'],
          },
        ],
      },
    },
  } as any);
  console.log('   Session:', session.id);

  console.log('4. Sending turn');
  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: 'What is the first line of src/flask/helpers.py? Use a tool, then answer with just that line.' } as any],
  });

  for await (const { data: event } of stream.withMetadata()) {
    const e: any = event;
    if (e.type === 'model.message.delta') continue;
    if (e.type === 'model.message' && Array.isArray(e.toolCalls) && e.toolCalls.length) {
      for (const tc of e.toolCalls) {
        console.log(`   -> tool call: ${tc.name} ${JSON.stringify(tc.arguments)}`);
      }
    } else if (e.type === 'tool.response') {
      const out = e.output ?? e.content ?? e.result;
      const txt = typeof out === 'string' ? out : JSON.stringify(out);
      console.log(`   <- tool response (${e.toolCallId}): ${String(txt).slice(0, 200)}`);
    } else if (e.type === 'turn.done') {
      console.log('5. turn.done state:', JSON.stringify(e.state, null, 1));
      break;
    } else if (e.type === 'tool.approval_required') {
      console.log('   -> approval required (unexpected for read tools):', e.toolCallId);
    }
  }

  await mcp.close();
  process.exit(0);
})().catch((err) => {
  console.error('FATAL:', err?.message ?? err);
  process.exit(1);
});
