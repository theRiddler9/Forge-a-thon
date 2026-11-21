import { structuredPatch } from 'diff';

export interface HunkInfo {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  state: 'pending' | 'accepted' | 'rejected';
}

export interface ApplyHunksResult {
  newContent: string;
  appliedCount: number;
  totalCount: number;
}

export function computeHunks(oldContent: string, newContent: string): HunkInfo[] {
  if (oldContent === newContent) {
    return [];
  }

  const patch = structuredPatch('original', 'modified', oldContent, newContent, '', '', { context: 1 });
  return patch.hunks.map((h, index) => {
    return {
      id: `hunk-${index + 1}-${h.oldStart}-${h.newStart}`,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
      state: 'pending',
    };
  });
}

export function applyHunks(
  oldContent: string,
  hunks: HunkInfo[],
  acceptedHunkIds: string[]
): ApplyHunksResult {
  if (hunks.length === 0 || acceptedHunkIds.length === 0) {
    return {
      newContent: oldContent,
      appliedCount: 0,
      totalCount: hunks.length,
    };
  }

  const acceptedSet = new Set(acceptedHunkIds);
  const hunksToApply = hunks.filter((h) => acceptedSet.has(h.id));

  // Sort descending by oldStart to prevent line shift from affecting preceding hunks
  const sortedHunks = [...hunksToApply].sort((a, b) => b.oldStart - a.oldStart);

  const eol = oldContent.includes('\r\n') ? '\r\n' : '\n';
  let lines = oldContent.split(/\r?\n/);
  const hadTrailingNewline = oldContent.endsWith('\n') || oldContent.endsWith('\r\n');
  if (hadTrailingNewline && lines[lines.length - 1] === '') {
    lines.pop();
  }

  for (const hunk of sortedHunks) {
    // Extract new lines from hunk (lines starting with ' ' or '+').
    // Strip trailing '\r' because structuredPatch embeds the original CR
    // into hunk line content; we rejoin using the detected EOL below.
    const replacementLines: string[] = [];
    for (const l of hunk.lines) {
      if (l.startsWith('\\')) continue; // Ignore '\ No newline at end of file'
      if (l.startsWith(' ') || l.startsWith('+')) {
        replacementLines.push(l.slice(1).replace(/\r$/, ''));
      }
    }

    const startIndex = Math.max(0, hunk.oldStart - 1);
    lines.splice(startIndex, hunk.oldLines, ...replacementLines);
  }

  let result = lines.join(eol);
  if (hadTrailingNewline && !result.endsWith(eol)) {
    result += eol;
  }

  return {
    newContent: result,
    appliedCount: hunksToApply.length,
    totalCount: hunks.length,
  };
}
