import { TrueForge } from '@truefoundry/trueforge-sdk';
import { startMcpServer } from '../src/mcp/server.js';

async function main() {
  console.log('1. Starting in-process MCP server...');
  const mcp = await startMcpServer({ workspaceRoot: 'C:/Work/Projects/flask' });
  console.log('MCP server running at:', mcp.url);

  console.log('2. Registering MCP server in TrueForge...');
  const client = new TrueForge({ baseUrl: 'http://localhost:8790' });
  await (client.settings.mcpServers as any).createOrUpdate({
    manifest: {
      name: 'forgepilot',
      type: 'remote',
      description: 'ForgePilot in-process editor tools',
      url: mcp.url,
    },
  });
  console.log('Registered MCP server in TrueForge.');

  console.log('3. Creating session with nvidia/nemotron-3-super-120b-a12b...');
  const sessionRes = await client.sessions.create({
    agent: {
      spec: {
        model: { name: 'nvidia/nemotron-3-super-120b-a12b' },
        instructions: 'You are a test agent. Always list tools first.',
        mcpServers: [
          {
            name: 'forgepilot',
            enableTools: ['@all'],
          },
        ],
      },
    },
  });
  console.log('Session created:', sessionRes.data.id);

  console.log('4. Streaming turn to verify tool discovery...');
  const stream = await client.sessions.createTurnStream(sessionRes.data.id, {
    input: [{ type: 'user.message', content: 'What MCP tools do you have available? List their names briefly.' }],
  });

  for await (const { data: event } of stream.withMetadata()) {
    const type = (event as any).type;
    if (type === 'turn.created') console.log('-> Turn created');
    if (type === 'model.message') console.log('-> Model message received');
    if (type === 'turn.done') {
      console.log('-> Turn done! Status:', (event as any).state?.status, (event as any).state?.error || '');
      break;
    }
  }

  await mcp.close();
  console.log('Done test.');
}

main().catch(console.error);
