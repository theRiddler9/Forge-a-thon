/**
 * Mask high-confidence credential shapes and secrets in workspace text
 * before sending to the model context.
 *
 * Original files on disk remain 100% untouched.
 */

const SECRET_PATTERNS: Array<{ regex: RegExp; replace: (match: string, ...args: any[]) => string }> = [
  // GitHub tokens (classic and fine-grained)
  {
    regex: /\b(ghp_[A-Za-z0-9_]{36})\b/g,
    replace: () => '***REDACTED_GITHUB_TOKEN***',
  },
  {
    regex: /\b(github_pat_[A-Za-z0-9_]{82})\b/g,
    replace: () => '***REDACTED_GITHUB_PAT***',
  },
  // AWS Access Key ID
  {
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
    replace: () => '***REDACTED_AWS_KEY***',
  },
  // OpenAI / Anthropic-style secret keys
  {
    regex: /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
    replace: () => '***REDACTED_API_KEY***',
  },
  // Slack tokens
  {
    regex: /\b(xox[baprs]-[A-Za-z0-9_-]{20,})\b/g,
    replace: () => '***REDACTED_SLACK_TOKEN***',
  },
  // Sensitive key assignments e.g. api_key = "...", password: "..."
  {
    regex: /((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*["'])([^"'\r\n]{6,})(["'])/gi,
    replace: (_match, prefix, _val, suffix) => `${prefix}***${suffix}`,
  },
  // Bearer tokens in headers
  {
    regex: /(Bearer\s+)([A-Za-z0-9_.\-+/~=]{16,})/gi,
    replace: (_match, prefix) => `${prefix}***REDACTED***`,
  },
];

export function maskSecrets(text: string): { maskedText: string; maskedCount: number } {
  let result = text;
  let count = 0;

  for (const { regex, replace } of SECRET_PATTERNS) {
    const matches = result.match(regex);
    if (matches) {
      count += matches.length;
      result = result.replace(regex, replace);
    }
  }

  return { maskedText: result, maskedCount: count };
}
