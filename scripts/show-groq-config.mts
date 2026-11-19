import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 15 });

(async () => {
  const res = await (client as any).settings.modelProviders.list();
  for (const p of res.data ?? []) {
    if (p.name !== 'groq') continue;
    const manifest = JSON.parse(JSON.stringify(p.manifest ?? {}));
    if (manifest.auth?.apiKey) manifest.auth.apiKey = '***REDACTED***';
    console.log(JSON.stringify({ name: p.name, manifest }, null, 1));
  }
  process.exit(0);
})().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
