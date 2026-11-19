import { TrueForge } from '@truefoundry/trueforge-sdk';
import { startMcpServer } from '../src/mcp/server.js';

const WORKSPACE = 'C:/Work/Projects/flask';
const MODEL = process.argv[2] ?? 'groq/openai-gpt-oss-120b';

(async () => {
  const mcp = await startMcpServer({ workspaceRoot: WORKSPACE });
  const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 300 });
  await (client.settings.mcpServers as any).createOrUpdate({
    manifest: { name: 'forgepilot', type: 'remote', description: 'ForgePilot editor tools', url: mcp.url },
  });

  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL },
        instructions: 'You are an inline code editing agent. Respond strictly by calling propose_write once with the modified content.',
        mcpServers: [
          {
            name: 'forgepilot',
            enableTools: ['propose_write'],
            requireApprovalForTools: ['@write', '@destructive', 'propose_write'],
            preload: true,
          },
        ],
      },
    },
  } as any);
  console.log('Session:', session.id);

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: `File: src/flask/helpers.py
Selected Code:
\`\`\`python
def get_debug_flag():
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`.\`\`"""
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in ("0", "false", "no"))
\`\`\`
Instruction: Treat the values 'off' and 'n' as false as well, case-insensitively. Call propose_write once.` } as any],
  });

  for await (const { data: event } of stream.withMetadata()) {
    const e: any = event;
    if (e.type === 'model.message.delta') continue;
    if (e.type === 'tool.approval_required') {
      console.log('APPROVAL REQUIRED for toolCall:', e.toolCallId);
      continue;
    }
    if (e.type === 'turn.done') {
      console.log('turn.done status:', e.state?.status, '| message:', e.state?.message ?? '(none)');
      console.log('requiredActions:', JSON.stringify(e.state?.requiredActions ?? []));
      break;
    }
  }
  await mcp.close();
  process.exit(0);
})().catch((err) => { console.error('FATAL:', err?.message ?? err); process.exit(1); });
