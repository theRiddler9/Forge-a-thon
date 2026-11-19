import { describe, it, expect } from 'vitest';
import { computeHunks, applyHunks, HunkInfo } from '../../src/edit/hunks.js';

describe('HunkEngine', () => {
  const original = [
    'def alpha():',
    '    return 1',
    '',
    'def beta():',
    '    return 2',
    '',
    'def gamma():',
    '    return 3',
  ].join('\n');

  const modified = [
    'def alpha():',
    '    return 10', // hunk 1
    '',
    'def beta():',
    '    return 2',
    '',
    'def gamma():',
    '    return 30', // hunk 2
  ].join('\n');

  it('computes unified hunks with deterministic IDs', () => {
    const hunks = computeHunks(original, modified);
    expect(hunks.length).toBe(2);
    expect(hunks[0].id).toBeDefined();
    expect(hunks[1].id).toBeDefined();
    expect(hunks[0].id).not.toBe(hunks[1].id);
  });

  it('applies all hunks when all are accepted', () => {
    const hunks = computeHunks(original, modified);
    const allIds = hunks.map((h) => h.id);
    const result = applyHunks(original, hunks, allIds);

    expect(result.appliedCount).toBe(2);
    expect(result.totalCount).toBe(2);
    expect(result.newContent).toBe(modified);
  });

  it('applies only accepted hunks and leaves rejected hunks unchanged', () => {
    const hunks = computeHunks(original, modified);
    // Only accept hunk 1 (alpha -> 10), reject hunk 2 (gamma remains 3)
    const result = applyHunks(original, hunks, [hunks[0].id]);

    expect(result.appliedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.newContent).toContain('return 10');
    expect(result.newContent).toContain('return 3');
    expect(result.newContent).not.toContain('return 30');
  });

  it('handles empty diff gracefully', () => {
    const hunks = computeHunks(original, original);
    expect(hunks.length).toBe(0);
    const result = applyHunks(original, hunks, []);
    expect(result.newContent).toBe(original);
    expect(result.appliedCount).toBe(0);
  });
});
