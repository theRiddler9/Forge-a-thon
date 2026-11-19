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
    if (snapshot) {
      try {
        fs.writeFileSync(snapshot.filePath, snapshot.restoredContent, 'utf8');
        vscode.window.showInformationMessage(
          `ForgePilot: Restored previous snapshot for ${vscode.workspace.asRelativePath(snapshot.filePath)}.`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`ForgePilot undo failed: ${err.message}`);
      }
    }
  });

  context.subscriptions.push(disposable);
}
