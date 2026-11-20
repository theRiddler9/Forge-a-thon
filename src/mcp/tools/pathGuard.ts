import path from 'path';

/**
 * Raised when a requested path resolves outside the opened workspace.
 */
export class WorkspaceEscapeError extends Error {
  constructor(public readonly requestedPath: string) {
    super(
      `Path "${requestedPath}" is outside the workspace root. ` +
        'ForgePilot only reads and writes inside the folder you opened.'
    );
    this.name = 'WorkspaceEscapeError';
  }
}

/**
 * Resolves `target` (relative or absolute) against `workspaceRoot` and asserts
 * the result stays inside it. Traversal (`..`), absolute paths outside the
 * root, and symlink-free assumptions are all handled by comparing the resolved
 * relative path rather than raw strings.
 */
export function resolveInWorkspace(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  const full = path.resolve(root, target);
  const rel = path.relative(root, full);

  if (rel === '') return full;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceEscapeError(target);
  }
  return full;
}

/**
 * Non-throwing containment check, used on paths that are already resolved
 * (for example a proposal staged before the guard existed).
 */
export function isInsideWorkspace(workspaceRoot: string, fullPath: string): boolean {
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, path.resolve(fullPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
