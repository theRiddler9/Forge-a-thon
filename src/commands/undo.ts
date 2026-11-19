import * as vscode from 'vscode';
import fs from 'fs';
import { globalSnapshotManager } from '../edit/snapshot.js';

export function registerUndoCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('forgepilot.undoLastChange', async () => {
    if (!globalSnapshotManager.canUndo()) {
      vscode.window.showInformationMessage('ForgePilot: No previous changes to undo.');
      return;
    }

    const snapshot = globalSnapshotManager.undoLastChange();
    if (!snapshot) {
      return;
    }

    try {
      const uri = vscode.Uri.file(snapshot.filePath);
      const restoredContent = snapshot.restoredContent;

      // Route through the editor so the restore joins the editor undo stack
      const edit = new vscode.WorkspaceEdit();
      const exists = fs.existsSync(snapshot.filePath);
      if (exists) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          doc.lineAt(doc.lineCount - 1).range.end
        );
        edit.replace(uri, fullRange, restoredContent);
      } else {
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), restoredContent);
      }

      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showErrorMessage('ForgePilot undo failed: editor rejected the restore. Files unchanged.');
        return;
      }
      const saved = await vscode.workspace.openTextDocument(uri);
      await saved.save();
      vscode.window.showInformationMessage(
        `ForgePilot: Restored previous snapshot for ${vscode.workspace.asRelativePath(snapshot.filePath)}.`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`ForgePilot undo failed: ${err.message}`);
    }
  });

  context.subscriptions.push(disposable);
}
