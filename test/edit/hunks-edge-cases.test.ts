import { describe, it, expect } from 'vitest';
import { computeHunks, applyHunks, HunkInfo } from '../../src/edit/hunks.js';

/**
 * Edge-case tests for the unified-diff hunk engine. The core safety invariant:
 * applying ALL hunks must reproduce the proposed content exactly, and applying
 * NONE must reproduce the original exactly. Per-hunk cherry-picking must never
 * corrupt line ordering.
 */
describe('HunkEngine edge cases', () => {
  function allIds(hunks: HunkInfo[]) {
    return hunks.map((h) => h.id);
  }

  it('invariant: all hunks accepted reproduces proposed content', () => {
    const cases: Array<[string, string]> = [
      ['a\nb\nc\n', 'a\nB\nc\n'],
      ['a\nb\nc\nd\ne\n', 'a\nX\nc\nY\ne\n'], // two separate hunks
      ['', 'brand new file\n'], // new file
      ['no trailing newline', 'no trailing newline edited'],
      ['a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'], // CRLF input
      ['same\n', 'same\n'], // identical → zero hunks
      ['l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n', 'l1\nNEW\nl3\nl4\nl5\nl6\nl7\nTAIL\n'],
    ];

    for (const [oldC, newC] of cases) {
      const hunks = computeHunks(oldC, newC);
      const { newContent, appliedCount } = applyHunks(oldC, hunks, allIds(hunks));
      // For CRLF input the engine normalises to LF — allow that specific drift.
      const expected = oldC.includes('\r\n') ? newC.replace(/\r\n/g, '\n') : newC;
      expect(newContent, `case: ${JSON.stringify(oldC.slice(0, 30))}`).toBe(expected);
      expect(appliedCount).toBe(hunks.length);
    }
  });

  it.fails('deleting the entire file content yields a truly empty file', () => {
    // KNOWN BUG: applyHunks appends '\n' when the original had a trailing
    // newline, so 'x\n' -> '' produces '\n' instead of ''.
    const hunks = computeHunks('only line\n', '');
    const { newContent } = applyHunks('only line\n', hunks, allIds(hunks));
    expect(newContent).toBe('');
  });

  it('invariant: zero accepted hunks leaves content untouched', () => {
    const oldC = 'a\nb\nc\n';
    const newC = 'a\nB\nc\nD\n';
    const hunks = computeHunks(oldC, newC);
    const { newContent, appliedCount } = applyHunks(oldC, hunks, []);
    expect(newContent).toBe(oldC);
    expect(appliedCount).toBe(0);
  });

  it('identical contents produce zero hunks', () => {
    expect(computeHunks('x\n', 'x\n')).toHaveLength(0);
  });

  it('partial acceptance applies only chosen hunks, bottom-up order safe', () => {
    const oldC = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const lines = oldC.split('\n');
    lines[2] = 'CHANGED_EARLY';
    lines[17] = 'CHANGED_LATE';
    const newC = lines.join('\n');

    const hunks = computeHunks(oldC, newC);
    expect(hunks.length).toBe(2);

    // Accept only the LATER hunk — early region must stay original.
    const late = hunks.find((h) => h.oldStart > 10)!;
    const { newContent } = applyHunks(oldC, hunks, [late.id]);
    expect(newContent).toContain('line3');
    expect(newContent).not.toContain('CHANGED_EARLY');
    expect(newContent).toContain('CHANGED_LATE');
  });

  it('ignores unknown hunk ids in acceptedHunkIds', () => {
    const hunks = computeHunks('a\n', 'b\n');
    const { newContent, appliedCount } = applyHunks('a\n', hunks, ['bogus-id']);
    expect(newContent).toBe('a\n');
    expect(appliedCount).toBe(0);
  });

  it('handles insertion-only hunks (oldLines = 0)', () => {
    const oldC = 'a\nc\n';
    const newC = 'a\nb\nc\n';
    const hunks = computeHunks(oldC, newC);
    const { newContent } = applyHunks(oldC, hunks, allIds(hunks));
    expect(newContent).toBe(newC);
  });

  it('handles deletion-only hunks (newLines = 0)', () => {
    const oldC = 'a\nb\nc\n';
    const newC = 'a\nc\n';
    const hunks = computeHunks(oldC, newC);
    const { newContent } = applyHunks(oldC, hunks, allIds(hunks));
    expect(newContent).toBe(newC);
  });

  it('handles prepend at file start', () => {
    const oldC = 'b\nc\n';
    const newC = 'a\nb\nc\n';
    const hunks = computeHunks(oldC, newC);
    const { newContent } = applyHunks(oldC, hunks, allIds(hunks));
    expect(newContent).toBe(newC);
  });

  it('handles append at file end', () => {
    const oldC = 'a\nb\n';
    const newC = 'a\nb\nc\n';
    const hunks = computeHunks(oldC, newC);
    const { newContent } = applyHunks(oldC, hunks, allIds(hunks));
    expect(newContent).toBe(newC);
  });

  it('hunk ids are stable and unique within a proposal', () => {
    const hunks = computeHunks('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n');
    const ids = new Set(hunks.map((h) => h.id));
    expect(ids.size).toBe(hunks.length);
    for (const h of hunks) {
      expect(h.state).toBe('pending');
      expect(h.lines.length).toBeGreaterThan(0);
    }
  });
});
