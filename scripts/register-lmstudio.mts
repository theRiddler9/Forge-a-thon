import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 30 });

(async () => {
  const manifest = {
    name: 'lmstudio',
    type: 'custom',
    baseUrl: 'http://localhost:1234/v1',
    auth: { apiKey: 'lmstudio' },
    models: [
      {
        modelId: 'qwen2.5-coder-7b-instruct',
        name: 'qwen25-coder-7b-instruct',
        properties: { contextLength: 32768, maxOutputTokens: 4096 },
      },
    ],
  };
  const res = await (client as any).settings.modelProviders.createOrUpdate({ manifest });
  console.log('registered:', JSON.stringify({ name: res?.data?.name ?? 'ok' }));
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e?.message ?? e);
  if (e?.body) console.error('body:', JSON.stringify(e.body));
  process.exit(1);
});
