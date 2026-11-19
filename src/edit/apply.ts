import * as vscode from 'vscode';
import fs from 'fs';
import { globalEditStaging } from './staging.js';
import { globalSnapshotManager } from './snapshot.js';

export interface EditorApplyResult {
  ok: boolean;
  appliedCount?: number;
  totalCount?: number;
  relativePath?: string;
  reason?: string;
}

/**
 * Applies the accepted hunks of a staged proposal through the editor.
 *
 * Every production write to the workspace flows through this helper:
 * edits go to the editor via WorkspaceEdit (joining the editor undo stack,
 * so Ctrl+Z reverts them) and are saved to disk afterwards. Nothing touches
 * disk until the edit is accepted by the editor pipeline.
 *
 * A snapshot is recorded after a successful apply so that
 * "ForgePilot: Undo Last Applied Change" can restore the previous state.
 */
export async function applyProposalViaEditor(proposalId: string): Promise<EditorApplyResult> {
  const preview = globalEditStaging.previewProposal(proposalId);
  if (!preview.success || preview.newContent == null || !preview.fullPath) {
    return { ok: false, reason: 'could not compute applied content (proposal may be gone)' };
  }

  const fullPath = preview.fullPath!;
  const newContent = preview.newContent ?? '';
  const uri = vscode.Uri.file(fullPath);
  const exists = fs.existsSync(fullPath);

  if ((preview.appliedCount ?? 0) === 0) {
    // Nothing was accepted — do not touch the document at all
    globalEditStaging.finalizeProposal(proposalId, 0, preview.totalCount ?? 0);
    return { ok: true, appliedCount: 0, totalCount: preview.totalCount ?? 0, relativePath: preview.relativePath };
  }

  const edit = new vscode.WorkspaceEdit();
  try {
    if (exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        doc.lineAt(doc.lineCount - 1).range.end
      );
      edit.replace(uri, fullRange, newContent);
    } else {
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), newContent);
    }
  } catch (err: any) {
    return { ok: false, reason: `could not build the edit: ${err?.message ?? err}` };
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    return { ok: false, reason: 'editor rejected the edit' };
  }

  globalSnapshotManager.createSnapshot(fullPath, preview.originalContent ?? '');
  const saved = await vscode.workspace.openTextDocument(uri);
  await saved.save();
  globalEditStaging.finalizeProposal(proposalId, preview.appliedCount, preview.totalCount);

  return {
    ok: true,
    appliedCount: preview.appliedCount,
    totalCount: preview.totalCount,
    relativePath: preview.relativePath,
  };
}
