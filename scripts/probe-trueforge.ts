import { TrueForge } from '@truefoundry/trueforge-sdk';

export interface TrueForgeProbeResult {
  reachable: boolean;
  serverUrl: string;
  modelsCount?: number;
  models?: string[];
  mcpServersCount?: number;
  error?: string;
}

export async function probeTrueForge(baseUrl: string = 'http://localhost:8790'): Promise<TrueForgeProbeResult> {
  const client = new TrueForge({
    baseUrl,
    timeoutInSeconds: 10,
  });

  try {
    const modelsResponse = await client.models.list();
    const models = modelsResponse.data?.map((m: any) => m.name || m.id) || [];
    
    let mcpServersCount = 0;
    try {
      const mcpResponse = await client.settings.mcpServers.list();
      mcpServersCount = mcpResponse.data?.length || 0;
    } catch {
      // MCP servers list might require specific setup or permissions
    }

    return {
      reachable: true,
      serverUrl: baseUrl,
      modelsCount: models.length,
      models,
      mcpServersCount,
    };
  } catch (err: any) {
    return {
      reachable: false,
      serverUrl: baseUrl,
      error: err?.message || String(err),
    };
  }
}

if (process.argv[1]?.includes('probe-trueforge')) {
  probeTrueForge().then((result) => {
    console.log('TrueForge Probe Result:', JSON.stringify(result, null, 2));
  });
}
