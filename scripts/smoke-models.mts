import { TrueForge } from '@truefoundry/trueforge-sdk';

const MODELS = [
  'nvidia/nemotron-3-super-120b-a12b', // value currently in .vscode/settings.json
  'nvidia/nvidia-nemotron-3-super-120b-a-12b', // value actually registered in TrueForge
  'groq/llama-3-3-70b-versatile',
  'google-gemini/gemini-3-8-flash',
];

const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 90 });

(async () => {
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const { data: session } = await client.sessions.create({
        agent: {
          spec: {
            model: { name: model },
            instructions: 'You are a terse test agent. Reply with exactly: OK',
          },
        },
      } as any);
      const stream = await client.sessions.createTurnStream(session.id, {
        input: [{ type: 'user.message', content: 'Reply with exactly: OK' } as any],
      });
      let text = '';
      let status = 'unknown';
      for await (const { data: event } of stream.withMetadata()) {
        const e: any = event;
        if (e.type === 'model.message.delta') {
          const t = e.delta?.content?.[0]?.text ?? e.delta?.text ?? '';
          text += t;
        } else if (e.type === 'model.message' && Array.isArray(e.content)) {
          for (const p of e.content) if (p?.text) text += p.text;
        } else if (e.type === 'turn.done') {
          status = e.state?.status ?? 'done';
          if (Array.isArray(e.state?.requiredActions) && e.state.requiredActions.length) {
            status += ` (requiredActions=${e.state.requiredActions.length})`;
          }
          break;
        } else if (e.type === 'turn.error' || e.type === 'error') {
          status = `error: ${e.message ?? JSON.stringify(e).slice(0, 200)}`;
          break;
        }
      }
      console.log(`OK   ${model} -> ${Date.now() - t0}ms status=${status} reply="${text.trim().slice(0, 80)}"`);
    } catch (err: any) {
      console.log(`FAIL ${model} -> ${Date.now() - t0}ms ${err?.message ?? err}`);
    }
  }
  process.exit(0);
})();
