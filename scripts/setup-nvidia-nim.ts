import { TrueForge } from '@truefoundry/trueforge-sdk';

export async function setupNvidiaNim(
  apiKey: string,
  modelName: string = 'meta/llama-3.3-70b-instruct',
  baseUrl: string = 'http://localhost:8790'
) {
  const client = new TrueForge({
    baseUrl,
    timeoutInSeconds: 30,
  });

  console.log(`Registering NVIDIA NIM provider with model ${modelName} on TrueForge (${baseUrl})...`);

  try {
    const response = await (client.settings.modelProviders as any).create({
      manifest: {
        type: 'openai',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        auth: {
          apiKey,
        },
        models: [
          {
            modelId: modelName,
            name: modelName,
            properties: {},
          },
        ],
      },
    });

    console.log('✓ Successfully registered NVIDIA NIM provider in TrueForge!');
    return response;
  } catch (err: any) {
    console.error(`Failed to register provider: ${err.message}`);
    throw err;
  }
}

if (process.argv[1]?.includes('setup-nvidia-nim')) {
  const apiKey = process.argv[2];
  const model = process.argv[3] || 'meta/llama-3.3-70b-instruct';

  if (!apiKey) {
    console.error('Usage: npx tsx scripts/setup-nvidia-nim.ts <NVIDIA_API_KEY> [MODEL_NAME]');
    console.error('Example: npx tsx scripts/setup-nvidia-nim.ts nvapi-xyz meta/llama-3.3-70b-instruct');
    process.exit(1);
  }

  setupNvidiaNim(apiKey, model)
    .then(() => {
      console.log('You can now use ForgePilot with your NVIDIA NIM model!');
      process.exit(0);
    })
    .catch(() => process.exit(1));
}
