import { TrueForge } from '@truefoundry/trueforge-sdk';

const MODEL = process.argv[2] ?? 'groq/llama-3-3-70b-versatile';
const client = new TrueForge({ baseUrl: 'http://localhost:8790', timeoutInSeconds: 120 });

(async () => {
  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: MODEL },
        instructions: 'You are a terse test agent. Reply with exactly: OK',
      },
    },
  } as any);
  console.log('session:', session.id);
  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: 'Reply with exactly: OK' } as any],
  });
  for await (const { data: event, id } of stream.withMetadata()) {
    const e: any = event;
    if (e.type === 'model.message.delta') {
      process.stdout.write('.');
      continue;
    }
    console.log(`\n--- event id=${id} type=${e.type}`);
    console.log(JSON.stringify(e, null, 1).slice(0, 1200));
    if (e.type === 'turn.done') break;
  }
  process.exit(0);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
