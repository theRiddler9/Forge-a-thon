import { describe, it, expect } from 'vitest';
import { maskSecrets } from '../../src/mcp/tools/maskSecrets.js';
import { getSanitizedChildEnv } from '../../src/mcp/tools/runCommand.js';

describe('maskSecrets', () => {
  it('masks GitHub personal access tokens', () => {
    const raw = 'const token = "ghp_123456789012345678901234567890123456";';
    const { maskedText, maskedCount } = maskSecrets(raw);
    expect(maskedCount).toBeGreaterThanOrEqual(1);
    expect(maskedText).not.toContain('ghp_123456789012345678901234567890123456');
    expect(maskedText).toContain('***');
  });

  it('masks AWS access key ids', () => {
    const raw = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
    const { maskedText, maskedCount } = maskSecrets(raw);
    expect(maskedCount).toBe(1);
    expect(maskedText).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(maskedText).toContain('***REDACTED_AWS_KEY***');
  });

  it('masks OpenAI secret keys', () => {
    const raw = 'export OPENAI_API_KEY="sk-abcdef12345678901234567890"';
    const { maskedText, maskedCount } = maskSecrets(raw);
    expect(maskedCount).toBeGreaterThanOrEqual(1);
    expect(maskedText).not.toContain('sk-abcdef12345678901234567890');
  });

  it('masks sensitive assignments like password = "..."', () => {
    const raw = 'password = "superSecretPassword123"';
    const { maskedText, maskedCount } = maskSecrets(raw);
    expect(maskedCount).toBe(1);
    expect(maskedText).toBe('password = "***"');
  });

  it('leaves benign source code unchanged', () => {
    const raw = 'def get_debug_flag() -> bool:\n    val = os.environ.get("FLASK_DEBUG")\n';
    const { maskedText, maskedCount } = maskSecrets(raw);
    expect(maskedCount).toBe(0);
    expect(maskedText).toBe(raw);
  });
});

describe('getSanitizedChildEnv', () => {
  it('strips secret-bearing environment variables from child process env', () => {
    process.env['TEST_SECRET_KEY'] = 'should-be-stripped';
    process.env['TEST_API_TOKEN'] = 'should-be-stripped-too';
    process.env['TEST_NORMAL_VAR'] = 'safe-value';

    const env = getSanitizedChildEnv();
    expect(env['TEST_SECRET_KEY']).toBeUndefined();
    expect(env['TEST_API_TOKEN']).toBeUndefined();
    expect(env['TEST_NORMAL_VAR']).toBe('safe-value');

    delete process.env['TEST_SECRET_KEY'];
    delete process.env['TEST_API_TOKEN'];
    delete process.env['TEST_NORMAL_VAR'];
  });
});
