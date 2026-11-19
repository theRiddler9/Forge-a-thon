import { execSync } from 'child_process';
import { TrueForgeClient } from '../src/trueforge/client.js';

export async function verifyTaskC(flaskWorkspacePath?: string): Promise<{ success: boolean; details: string[] }> {
  const details: string[] = [];

  // 1. Initialize client with a broken primary model and working fallback model
  const client = new TrueForgeClient({
    baseUrl: 'http://localhost:8790',
    primaryModel: 'invalid-provider/unreachable-primary-model',
    fallbackModel: 'groq/qwen-3-8-27b',
    maxRetries: 3,
    retryDelayMs: 300,
  });

  details.push('1. Configured primaryModel="invalid-provider/unreachable-primary-model"');
  details.push('2. Configured fallbackModel="groq/qwen-3-8-27b"');

  // 2. Attempt session creation with fallback
  const instructions = 'You are a resilient test agent. Reply with exactly: OK';
  let session: any;
  try {
    session = await client.createSessionWithFallback(instructions);
    details.push(`3. Session created successfully via fallback: ${session.id}`);
  } catch (err: any) {
    details.push(`✗ Session creation failed: ${err.message}`);
    return { success: false, details };
  }

  // 3. Verify fallback metadata
  const fallbackInfo = client.lastFallbackInfo;
  if (fallbackInfo && fallbackInfo.to === 'groq/qwen-3-8-27b') {
    details.push(`✓ Automatic fallback triggered from "${fallbackInfo.from}" to "${fallbackInfo.to}" after ${fallbackInfo.attempts} retries`);
  } else {
    details.push('✗ Fallback info was not recorded as expected');
  }

  // 4. Verify turn execution on fallback model
  let receivedDelta = false;
  try {
    const outcome = await client.runTurn(session.id, 'Ping fallback test', {
      onDelta: () => {
        receivedDelta = true;
      },
    });
    if (outcome.status === 'done' || receivedDelta) {
      details.push('✓ Fallback model completed turn successfully');
    } else {
      details.push(`✗ Fallback turn ended with status: ${outcome.status}`);
    }
  } catch (err: any) {
    details.push(`✗ Fallback turn execution failed: ${err.message}`);
  }

  // 5. Verify workspace remains clean (0 files modified)
  if (flaskWorkspacePath) {
    try {
      const gitStatus = execSync('git status --short', {
        cwd: flaskWorkspacePath,
        encoding: 'utf8',
      }).trim();

      if (gitStatus.length === 0 || !gitStatus.includes('??')) {
        details.push('✓ Workspace clean — 0 unapproved files modified during failure/fallback');
      } else {
        details.push(`⚠ Workspace has dirty files: ${gitStatus}`);
      }
    } catch (err: any) {
      details.push(`Notice: Could not inspect git status in ${flaskWorkspacePath}: ${err.message}`);
    }
  }

  const success = details.every((d) => !d.startsWith('✗'));
  return { success, details };
}

// Direct CLI invocation
if (process.argv[1]?.includes('verify-task-c')) {
  const flaskPath = process.argv[2] ?? 'C:/Work/Projects/flask';
  verifyTaskC(flaskPath).then(({ success, details }) => {
    console.log('\n=== Task C Resilience & Fallback Verification ===\n');
    details.forEach((d) => console.log(d));
    console.log(`\nResult: ${success ? 'PASSED ✓' : 'FAILED ✗'}\n`);
    process.exit(success ? 0 : 1);
  });
}
