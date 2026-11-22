import { TrueForge } from '@truefoundry/trueforge-sdk';

const MODELS = [
  'google-gemini/gemini-3-1-flash-lite',
  'google-gemini/gemini-flash-lite-latest',
  'groq/openai-gpt-oss-120b',
  'groq/openai-gpt-oss-20b',
  'groq/qwen-3-8-27b',
];

const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 120 });

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
        if (e.type === 'model.message.delta' && typeof e.content === 'string') {
          text += e.content;
        } else if (e.type === 'turn.done') {
          status = e.state?.status ?? 'done';
          const out = e.state?.output;
          if (!text && typeof out?.content === 'string') text = out.content;
          if (Array.isArray(e.state?.requiredActions) && e.state.requiredActions.length) {
            status += ` (requiredActions=${e.state.requiredActions.length})`;
          }
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
